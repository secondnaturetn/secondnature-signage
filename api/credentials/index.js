module.exports = async function (context, req) {
    context.res.headers['Content-Type'] = 'application/json';
    context.res.headers['Access-Control-Allow-Origin'] = '*';
    context.res.headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
    context.res.headers['Access-Control-Allow-Headers'] = 'Content-Type';

    // Handle CORS preflight requests
    if (req.method === 'OPTIONS') {
        context.res.status = 200;
        context.res.body = {};
        return;
    }

    try {
        // Get environment variables
        const token = process.env.GPS_TOKEN;
        const username = process.env.GPS_USERNAME;
        const password = process.env.GPS_PASSWORD;

        // Validate that credentials are set
        if (!token || !username || !password) {
            context.res.status = 400;
            context.res.body = {
                error: 'Missing GPS credentials. Please configure GPS_TOKEN, GPS_USERNAME, and GPS_PASSWORD environment variables.'
            };
            return;
        }

        // Return credentials to frontend
        context.res.status = 200;
        context.res.body = {
            token: token,
            username: username,
            password: password
        };
    } catch (error) {
        context.res.status = 500;
        context.res.body = {
            error: 'Error retrieving credentials: ' + error.message
        };
    }
};
