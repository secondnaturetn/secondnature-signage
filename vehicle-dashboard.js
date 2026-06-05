(() => {
    const REFRESH_MS = 5 * 60 * 1000;
    const CLOCK_MS = 1000;
    const PARKED_CUSTOMER_LOOKUP_MS = 3 * 60 * 1000;
    const MAP_BOUNDS = {
        north: 37.25,
        south: 34.85,
        west: -90.35,
        east: -84.9
    };

    let state = {
        root: null,
        refreshButton: null,
        clock: null,
        refreshTimer: 0,
        clockTimer: 0
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

        setLoading(true);
        state.root.innerHTML = '<div class="dashboard-status">Loading vehicle data...</div>';

        try {
            const response = await fetch('/api/vehicles');
            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || `API Error: ${response.status} ${response.statusText}`);
            }

            const vehicles = normalizeVehicles(data.vehicles).map(normalizeVehicle);
            await hydrateParkedCustomerMatches(vehicles);
            renderVehicles(vehicles, data.updatedAt);
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
        const parkedForMs = getParkedForMs(vehicle, motion, fixTime);
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

    function getParkedForMs(vehicle, motion, fixTime) {
        const speedLabel = String(firstValue(vehicle.speed_label, vehicle.status, '')).toLowerCase();
        const parsed = parseDurationFromLabel(speedLabel);

        if (parsed !== null) return parsed;
        if ((motion === 'stopped' || motion === 'idle') && fixTime) {
            return Math.max(0, Date.now() - fixTime.getTime());
        }

        return 0;
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
            state.root.innerHTML = '<div class="empty-state">No vehicles found</div>';
            return;
        }

        const updated = parseDate(updatedAt) || new Date();
        const cards = vehicles
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
            .map(createVehicleCard)
            .join('');

        state.root.innerHTML = `
            <div class="dashboard-meta">Last data refresh: ${escapeHtml(updated.toLocaleTimeString())}</div>
            <div class="vehicle-grid">${cards}</div>
        `;
    }

    function createVehicleCard(vehicle) {
        const motionLabel = getMotionLabel(vehicle.motion);
        const speedText = Number.isFinite(vehicle.speed) ? `${Math.round(vehicle.speed)} mph` : 'Speed unavailable';
        const checkInText = vehicle.fixTime ? vehicle.fixTime.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'Unavailable';
        const parkedText = vehicle.parkedForMs > 0 ? formatDuration(vehicle.parkedForMs) : vehicle.speedLabel || 'Unavailable';
        const customerText = getCustomerText(vehicle);
        const driverText = vehicle.driverName || 'Unassigned';

        return `
            <article class="vehicle-card">
                <div class="vehicle-card-header">
                    <h2 class="vehicle-name">${escapeHtml(vehicle.name)}</h2>
                    <span class="motion-pill motion-${vehicle.motion}">${escapeHtml(motionLabel)}</span>
                </div>
                <div class="vehicle-summary">
                    <div class="info-item">
                        <div class="info-label">Technician</div>
                        <div class="info-value">${escapeHtml(driverText)}</div>
                    </div>
                    <div class="info-item">
                        <div class="info-label">Speed</div>
                        <div class="info-value">${escapeHtml(speedText)}</div>
                    </div>
                </div>
                <div class="map-frame" aria-label="Approximate Middle Tennessee vehicle location">
                    ${createMapSvg(vehicle)}
                </div>
                <div class="vehicle-footer">
                    <div class="info-item">
                        <div class="info-label">Last Check-In</div>
                        <div class="info-value">${escapeHtml(checkInText)}</div>
                    </div>
                    <div class="info-item">
                        <div class="info-label">Parked / Idle</div>
                        <div class="info-value">${escapeHtml(parkedText)}</div>
                    </div>
                    <div class="customer-slot">
                        <div class="info-label">Customer Match</div>
                        <div class="info-value">${escapeHtml(customerText)}</div>
                    </div>
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

    function createMapSvg(vehicle) {
        const marker = project(vehicle.latitude, vehicle.longitude);
        const markerSvg = marker ? `
            <circle class="truck-marker-ring" cx="${marker.x}" cy="${marker.y}" r="15"></circle>
            <circle class="truck-marker" cx="${marker.x}" cy="${marker.y}" r="6"></circle>
        ` : '';

        return `
            <svg viewBox="0 0 320 180" role="img" aria-hidden="true">
                <rect width="320" height="180" fill="#dce9e5"></rect>
                <path d="M0 118 C46 108 80 102 122 101 C170 100 216 93 320 82" class="road road-major"></path>
                <path d="M150 0 C156 35 158 74 155 104 C152 132 148 158 142 180" class="road road-major"></path>
                <path d="M190 180 C184 145 176 126 155 104 C132 80 118 56 92 0" class="road road-major"></path>
                <path d="M0 80 C46 78 96 82 155 104 C205 122 252 129 320 126" class="road road-secondary"></path>
                <path d="M62 180 C82 150 104 128 155 104 C214 76 252 42 286 0" class="road road-secondary"></path>
                <circle cx="155" cy="104" r="4" fill="#405b55"></circle>
                <text x="164" y="102" class="map-label">Nashville</text>
                <text x="42" y="113" class="road-label">I-40</text>
                <text x="160" y="48" class="road-label">I-65</text>
                <text x="184" y="144" class="road-label">I-24</text>
                ${markerSvg}
            </svg>
        `;
    }

    function project(latitude, longitude) {
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

        const x = ((longitude - MAP_BOUNDS.west) / (MAP_BOUNDS.east - MAP_BOUNDS.west)) * 320;
        const y = ((MAP_BOUNDS.north - latitude) / (MAP_BOUNDS.north - MAP_BOUNDS.south)) * 180;

        return {
            x: Math.max(8, Math.min(312, x)),
            y: Math.max(8, Math.min(172, y))
        };
    }

    function getDriverName(vehicle) {
        const driver = vehicle.driver || {};
        return firstValue(
            vehicle.driver_name,
            vehicle.driverName,
            vehicle.driver_full_name,
            driver.name,
            [driver.first_name, driver.last_name].filter(Boolean).join(' '),
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
