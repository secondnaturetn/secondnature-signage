module.exports = async function (context, req) {
  const GPS_TOKEN = process.env.GPS_TOKEN;

  if (!GPS_TOKEN) {
    context.res = {
      status: 500,
      body: { error: "GPS_TOKEN environment variable is missing" }
    };
    return;
  }

  const GPS_BASE = "https://api.gpsinsight.com/v2";
  const url = new URL(`${GPS_BASE}/vehicle/location`);
  url.searchParams.set("session_token", GPS_TOKEN);

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json"
      }
    });

    const text = await response.text();
    let details = text;

    try {
      details = text ? JSON.parse(text) : null;
    } catch (parseError) {
      details = text;
    }

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
      status: 500,
      body: { error: err.message }
    };
  }
};
