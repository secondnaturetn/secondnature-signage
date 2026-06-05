(() => {
    const REFRESH_MS = 5 * 60 * 1000;
    const CLOCK_MS = 1000;
    const AUTO_SCROLL_MS = 90;
    const AUTO_SCROLL_STEP = 1;
    const AUTO_SCROLL_PAUSE_MS = 3500;
    const PARKED_CUSTOMER_LOOKUP_MS = 3 * 60 * 1000;

    let state = {
        root: null,
        refreshButton: null,
        clock: null,
        refreshTimer: 0,
        clockTimer: 0,
        scrollTimer: 0,
        scrollPausedUntil: 0
    };

    function mount({ root, refreshButton, clock }) {
        state = { ...state, root, refreshButton, clock };

        refreshButton?.addEventListener('click', fetchVehicles);
        startClock();
        fetchVehicles();
        state.refreshTimer = window.setInterval(fetchVehicles, REFRESH_MS);
    }

    function startClock() {
        updateClock();
        state.clockTimer = window.setInterval(updateClock, CLOCK_MS);
    }

    function updateClock() {
        if (!state.clock) return;

        const now = new Date();
        state.clock.textContent = now.toLocaleString([], {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            second: '2-digit'
        });
        state.clock.setAttribute('datetime', now.toISOString());
    }

    async function fetchVehicles() {
        if (!state.root) return;

        stopAutoScroll();
        setLoading(true);
        state.root.innerHTML = '<div class="dashboard-status">Loading vehicle data...</div>';

        try {
            const response = await fetch('/api/vehicles');
            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || `API Error: ${response.status} ${response.statusText}`);
            }

            const vehicles = normalizeVehicles(data.vehicles)
                .map(normalizeVehicle)
                .filter(hasMovementToday);

            await hydrateParkedCustomerMatches(vehicles);
            renderVehicles(vehicles, data.updatedAt);
            startAutoScrollIfNeeded();
        } catch (error) {
            state.root.innerHTML = `<div class="dashboard-error">Error loading vehicles: ${escapeHtml(error.message)}</div>`;
        } finally {
            setLoading(false);
        }
    }

    function setLoading(isLoading) {
        if (!state.refreshButton) return;

        state.refreshButton.disabled = isLoading;
        state.refreshButton.textContent = isLoading ? 'Refreshing' : 'Refresh';
    }

    function normalizeVehicles(payload) {
        if (Array.isArray(payload)) return payload;
        if (Array.isArray(payload?.data)) return payload.data;
        if (Array.isArray(payload?.vehicles)) return payload.vehicles;
        if (payload && typeof payload === 'object') return [payload];
        return [];
    }

    function normalizeVehicle(vehicle) {
        const latitude = numeric(firstValue(vehicle.latitude, vehicle.lat, vehicle.location?.latitude));
        const longitude = numeric(firstValue(vehicle.longitude, vehicle.lon, vehicle.lng, vehicle.location?.longitude));
        const speed = numeric(firstValue(vehicle.inst_speed, vehicle.instant_speed, vehicle.speed, vehicle.current_speed));
        const fixTimeValue = firstValue(vehicle.fix_time_gmt, vehicle.fix_time, vehicle.last_checkin_time, vehicle.lastCheckIn);
        const fixTime = parseDate(fixTimeValue);
        const motion = getMotionState(vehicle, speed);
        const parkedForMs = getParkedForMs(vehicle, motion);
        const driverName = getDriverName(vehicle);

        return {
            raw: vehicle,
            name: String(firstValue(vehicle.label, vehicle.name, vehicle.vehicle_name, vehicle.vehicleName, 'Unknown')).trim(),
            latitude,
            longitude,
            speed,
            ignition: String(firstValue(vehicle.ignition, vehicle.ignition_status, '')).trim(),
            speedLabel: String(firstValue(vehicle.speed_label, vehicle.status, '')).trim(),
            fixTime,
            motion,
            parkedForMs,
            driverName,
            customerMatch: null
        };
    }

    function getMotionState(vehicle, speed) {
        const ignition = String(firstValue(vehicle.ignition, vehicle.ignition_status, '')).toLowerCase();
        const speedLabel = String(firstValue(vehicle.speed_label, vehicle.status, '')).toLowerCase();

        if (Number.isFinite(speed) && speed > 1) return 'moving';
        if (speedLabel.includes('idle')) return 'idle';
        if (speedLabel.includes('stop') || speedLabel.includes('park')) return 'stopped';
        if (ignition === 'on' || ignition === 'running') return 'idle';
        if (ignition === 'off') return 'stopped';

        return Number.isFinite(speed) && speed <= 1 ? 'stopped' : 'unknown';
    }

    function getParkedForMs(vehicle, motion) {
        const speedLabel = String(firstValue(vehicle.speed_label, vehicle.status, '')).toLowerCase();
        const parsed = parseDurationFromLabel(speedLabel);

        if (parsed !== null) return parsed;
        return motion === 'stopped' || motion === 'idle' ? 0 : 0;
    }

    function parseDurationFromLabel(label) {
        const match = label.match(/(?:idle\s+stop|stopped|stop|parked|idle)\s+(?:for\s+)?(\d+)\s*(min|mins|minute|minutes|hr|hrs|hour|hours|day|days)/i);
        if (!match) return null;

        const amount = Number(match[1]);
        const unit = match[2].toLowerCase();

        if (unit.startsWith('min')) return amount * 60 * 1000;
        if (unit.startsWith('hr') || unit.startsWith('hour')) return amount * 60 * 60 * 1000;
        if (unit.startsWith('day')) return amount * 24 * 60 * 60 * 1000;

        return null;
    }

    function hasMovementToday(vehicle) {
        if (!vehicle.fixTime) return false;

        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);

        if (vehicle.fixTime < startOfToday) return false;
        if (vehicle.motion === 'moving') return true;
        if (!vehicle.parkedForMs) return true;

        return vehicle.parkedForMs < Date.now() - startOfToday.getTime();
    }

    async function hydrateParkedCustomerMatches(vehicles) {
        const lookup = window.VehicleDashboardCustomerLookup;
        if (typeof lookup !== 'function') return;

        await Promise.all(vehicles.map(async vehicle => {
            if (!isReadyForCustomerLookup(vehicle)) return;
            vehicle.customerMatch = await lookup({
                latitude: vehicle.latitude,
                longitude: vehicle.longitude,
                vehicle: vehicle.raw
            });
        }));
    }

    function isReadyForCustomerLookup(vehicle) {
        return hasLocation(vehicle) &&
            (vehicle.motion === 'stopped' || vehicle.motion === 'idle') &&
            vehicle.parkedForMs >= PARKED_CUSTOMER_LOOKUP_MS;
    }

    function renderVehicles(vehicles, updatedAt) {
        if (vehicles.length === 0) {
            state.root.innerHTML = '<div class="empty-state">No trucks have movement data from today.</div>';
            return;
        }

        const updated = parseDate(updatedAt) || new Date();
        const rows = vehicles
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
            .map(createVehicleRow)
            .join('');

        state.root.innerHTML = `
            <div class="dashboard-meta">
                <span>${vehicles.length} active today</span>
                <span>Last data refresh: ${escapeHtml(updated.toLocaleTimeString())}</span>
            </div>
            <div class="vehicle-board">${rows}</div>
        `;
    }

    function createVehicleRow(vehicle) {
        const motionLabel = getMotionLabel(vehicle.motion);
        const speedText = Number.isFinite(vehicle.speed) ? `${Math.round(vehicle.speed)} mph` : 'Unavailable';
        const checkInText = vehicle.fixTime ? vehicle.fixTime.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'Unavailable';
        const parkedText = vehicle.parkedForMs > 0 ? formatDuration(vehicle.parkedForMs) : vehicle.speedLabel || 'Active today';
        const customerText = getCustomerText(vehicle);
        const driverText = vehicle.driverName || 'Unassigned';

        return `
            <article class="vehicle-row">
                <div class="vehicle-identity">
                    <div class="vehicle-name">${escapeHtml(vehicle.name)}</div>
                    <span class="motion-pill motion-${vehicle.motion}">${escapeHtml(motionLabel)}</span>
                </div>
                <div class="row-field technician-field">
                    <div class="info-label">Technician</div>
                    <div class="info-value">${escapeHtml(driverText)}</div>
                </div>
                <div class="row-field">
                    <div class="info-label">Speed</div>
                    <div class="info-value">${escapeHtml(speedText)}</div>
                </div>
                <div class="row-field">
                    <div class="info-label">Last Check-In</div>
                    <div class="info-value">${escapeHtml(checkInText)}</div>
                </div>
                <div class="row-field">
                    <div class="info-label">Parked / Idle</div>
                    <div class="info-value">${escapeHtml(parkedText)}</div>
                </div>
                <div class="row-field customer-field">
                    <div class="info-label">Customer Match</div>
                    <div class="info-value">${escapeHtml(customerText)}</div>
                </div>
                <div class="map-frame" aria-label="Approximate vehicle location">
                    ${createMapImage(vehicle)}
                </div>
            </article>
        `;
    }

    function getMotionLabel(motion) {
        if (motion === 'moving') return 'Moving';
        if (motion === 'idle') return 'Idle';
        if (motion === 'stopped') return 'Parked';
        return 'Unknown';
    }

    function getCustomerText(vehicle) {
        if (!hasLocation(vehicle)) return 'Location unavailable';
        if (!isReadyForCustomerLookup(vehicle)) return 'Pending parked time';
        if (!vehicle.customerMatch) return 'No match yet';

        return firstValue(
            vehicle.customerMatch.displayName,
            vehicle.customerMatch.customerName,
            vehicle.customerMatch.name,
            vehicle.customerMatch.address,
            'Matched'
        );
    }

    function createMapImage(vehicle) {
        if (!hasLocation(vehicle)) {
            return '<div class="map-unavailable">Map unavailable</div>';
        }

        const lat = vehicle.latitude.toFixed(5);
        const lon = vehicle.longitude.toFixed(5);
        const src = `https://staticmap.openstreetmap.de/staticmap.php?center=${lat},${lon}&zoom=10&size=300x126&maptype=mapnik&markers=${lat},${lon},red-pushpin`;

        return `<img src="${src}" alt="Approximate location for truck ${escapeHtml(vehicle.name)}" loading="lazy" referrerpolicy="no-referrer">`;
    }

    function startAutoScrollIfNeeded() {
        if (!state.root || state.root.scrollHeight <= state.root.clientHeight + 4) return;

        state.scrollPausedUntil = Date.now() + AUTO_SCROLL_PAUSE_MS;
        state.scrollTimer = window.setInterval(() => {
            if (!state.root || Date.now() < state.scrollPausedUntil) return;

            const maxScroll = state.root.scrollHeight - state.root.clientHeight;
            if (state.root.scrollTop >= maxScroll - 2) {
                state.root.scrollTop = 0;
                state.scrollPausedUntil = Date.now() + AUTO_SCROLL_PAUSE_MS;
                return;
            }

            state.root.scrollTop += AUTO_SCROLL_STEP;
        }, AUTO_SCROLL_MS);
    }

    function stopAutoScroll() {
        if (state.scrollTimer) {
            window.clearInterval(state.scrollTimer);
            state.scrollTimer = 0;
        }

        if (state.root) state.root.scrollTop = 0;
    }

    function getDriverName(vehicle) {
        const driver = vehicle.driver || {};
        return firstValue(
            vehicle.driver_name,
            vehicle.driverName,
            vehicle.driver_full_name,
            vehicle.driverFullName,
            vehicle.driver_first_name && vehicle.driver_last_name ? `${vehicle.driver_first_name} ${vehicle.driver_last_name}` : '',
            driver.full_name,
            driver.fullName,
            driver.name,
            driver.first_name && driver.last_name ? `${driver.first_name} ${driver.last_name}` : '',
            driver.firstName && driver.lastName ? `${driver.firstName} ${driver.lastName}` : '',
            vehicle.driver_id,
            driver.id,
            ''
        );
    }

    function hasLocation(vehicle) {
        return Number.isFinite(vehicle.latitude) && Number.isFinite(vehicle.longitude);
    }

    function formatDuration(ms) {
        const totalMinutes = Math.max(0, Math.round(ms / 60000));
        if (totalMinutes < 60) return `${totalMinutes} min`;

        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        return minutes ? `${hours} hr ${minutes} min` : `${hours} hr`;
    }

    function parseDate(value) {
        if (!value) return null;
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? null : date;
    }

    function numeric(value) {
        if (value === null || value === undefined || value === '') return NaN;
        const number = Number(value);
        return Number.isFinite(number) ? number : NaN;
    }

    function firstValue(...values) {
        for (const value of values) {
            if (value !== null && value !== undefined && value !== '') return value;
        }

        return '';
    }

    function escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    window.SecondNatureVehicleDashboard = { mount };
})();
