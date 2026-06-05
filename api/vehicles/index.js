module.exports = async function (context, req) {
  const GPS_BASE = "https://api.gpsinsight.com/v2";

  try {
    const sessionToken = await getSessionToken();
    const url = new URL(`${GPS_BASE}/vehicle/location`);
    url.searchParams.set("session_token", sessionToken);

    const response = await fetch(url, {
      headers: {
        Accept: "application/json"
      }
    });

    const details = await readJsonResponse(response);
    const isGpsError = details?.head?.status === "ERROR";
    const status = response.ok && isGpsError ? 502 : response.status;

    context.res = {
      status,
      headers: {
        "Content-Type": "application/json"
      },
      body: response.ok && !isGpsError
        ? {
            updatedAt: new Date().toISOString(),
            vehicles: details
          }
        : {
            error: "GPS Insight request failed",
            status,
            details
          }
    };
  } catch (err) {
    context.res = {
      status: err.status || 500,
      headers: {
        "Content-Type": "application/json"
      },
      body: { error: err.message }
    };
  }
};

async function getSessionToken() {
  const sessionToken = env("GPS_SESSION_TOKEN", "GPS_TOKEN", "GPS_Token");
  const username = env("GPS_USERNAME", "GPS_Username");
  const password = env("GPS_PASSWORD", "GPS_Password");
  const appToken = env("GPS_APP_TOKEN", "GPS_App_Token");

  if (username && (password || appToken)) {
    return login(username, { password, appToken });
  }

  if (sessionToken) {
    return sessionToken;
  }

  const error = new Error(
    "GPS Insight credentials not configured. Set GPS_TOKEN for a session token, or set GPS_USERNAME plus GPS_PASSWORD or GPS_APP_TOKEN. Mixed-case Azure names GPS_Token, GPS_Username, and GPS_Password are also supported."
  );
  error.status = 500;
  throw error;
}

async function login(username, { password, appToken }) {
  const url = new URL("https://api.gpsinsight.com/v2/userauth/login");
  url.searchParams.set("username", username);

  if (appToken) {
    url.searchParams.set("app_token", appToken);
  } else {
    url.searchParams.set("password", password);
  }

  const response = await fetch(url, {
    headers: {
      Accept: "application/json"
    }
  });

  const details = await readJsonResponse(response);
  const token = findSessionToken(details);

  if (response.ok && details?.head?.status !== "ERROR" && token) {
    return token;
  }

  const error = new Error("GPS Insight login failed");
  error.status = response.ok ? 502 : response.status;
  error.details = details;
  throw error;
}

async function readJsonResponse(response) {
  const text = await response.text();

  try {
    return text ? JSON.parse(text) : null;
  } catch (parseError) {
    return text;
  }
}

function findSessionToken(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  if (typeof payload.session_token === "string") return payload.session_token;
  if (typeof payload.sessionToken === "string") return payload.sessionToken;
  if (typeof payload.token === "string") return payload.token;

  const data = payload.data;

  if (Array.isArray(data)) {
    for (const item of data) {
      const token = findSessionToken(item);
      if (token) return token;
    }
  } else if (data && typeof data === "object") {
    return findSessionToken(data);
  }

  return null;
}

function env(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }

  return "";
}
