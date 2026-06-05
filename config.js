// This file should be protected/not committed to public repos
// In production, use Azure Key Vault or a proper backend API

window.gpsCredentials = {
    username: process.env.GPS_USERNAME || 'secondnaturelcgps',
    password: process.env.GPS_PASSWORD || '',
    token: process.env.GPS_TOKEN || ''
};
