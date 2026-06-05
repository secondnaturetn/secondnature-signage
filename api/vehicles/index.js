module.exports = async function (context, req) {
  const GPS_TOKEN = process.env.GPS_TOKEN;

  if (!GPS_TOKEN) {
    context.res = {
      status: 500,
      body: { error: "GPS_TOKEN environment variable is missing" }
    };
    return;
  }

  const GPS_BASE = "https://api.gpsinsight.com";

  try {
    const response = await fetch(`${GPS_BASE}/v2/vehicle`, {
      headers: {
        Authorization: `Bearer ${GPS_TOKEN}`,
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

    context.res = {
      status: response.status,
      headers: {
        "Content-Type": "application/json"
      },
      body: response.ok
        ? {
            updatedAt: new Date().toISOString(),
            vehicles: details
          }
        : {
            error: "GPS Insight request failed",
            status: response.status,
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
