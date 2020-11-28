const { uuid } = require('uuidv4');
const jsrsasign = require('jsrsasign');

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

/**
 * Fetch and log a request
 * @param {Request} request
 */
async function handleRequest(request) {
  const urls = (await K8S_DASHBOARD_AUTH.get('tunnelHostnames')).split(',');
  const email = find_email(request.headers);
  const data = await find_user_data(email)
    .then(data => {
      return data
    })
    .catch(async function (err) {
      return sendSentryErr(err)
    });
  const userToken = data['token'];
  var proxyHeaders = new Headers(request.headers);
  proxyHeaders.append('Authorization', 'Bearer ' + userToken);

  for (var i = 0; i < urls.length; i++) {
    const requestedURL = new URL(request.url);
    const path = requestedURL.pathname;
    const url = new URL(`https://${urls[0]}/${path}`);
    const proxyReq = new Request(
      url,
      {
        method: request.method,
        headers: proxyHeaders,
      },
    );
    const resp = await fetch(proxyReq)
      .then(resp => {
        return resp
      })
      .catch(async function (err) {
        await sendSentryErr(err)
        return new Response(err, {
          "status": 503,
          "statusText": "Service Unavailable",
          "headers": { 'Content-Type': 'text/plain' }
        })
      });
    // Retry the next url on 502 error, when the tunnel cannot connect to the origin
    // or 503, when the tunnel is unregistered, or when the worker cannot fetch the tunnel
    if (resp.status != 502 || resp.status != 503) {
      return resp
    }
  }
  return new Response("Exhausted all fallback options", {
    "status": 500,
    "statusText": "Service Unavailable",
    "headers": { 'Content-Type': 'text/plain' }
  })
}

function find_email(headers) {
  const jws = headers.get("Cf-Access-Jwt-Assertion");
  const claim = jsrsasign.KJUR.jws.JWS.readSafeJSONString(jsrsasign.b64utoutf8(jws.split(".")[1]));
  return claim['email']
}

async function find_user_data(email) {
  const data = await K8S_DASHBOARD_AUTH.get(email);
  if (data == null) {
    throw `No token for ${email}`
  }
  return JSON.parse(data)
}

async function sendSentryErr(err) {
  const currentTimestamp = Date.now() / 1000;
  const body = sentryEventJson(err, currentTimestamp);
  const sentryProectID = await SLACK_BRIDGE.get("sentryProjectID");
  const sentryKey = await SLACK_BRIDGE.get("sentryKey");
  return fetch(`https://sentry.io/api/${sentryProectID}/store/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Sentry-Auth': [
        'Sentry sentry_version=7',
        `sentry_timestamp=${currentTimestamp}`,
        `sentry_client=auth-proxy-logger/0`,
        `sentry_key=${sentryKey}`
      ].join(', '),
    },
    body,
  });
}

function sentryEventJson(err, currentTimestamp) {
  return JSON.stringify({
    event_id: uuid(),
    message: JSON.stringify(err),
    timestamp: currentTimestamp,
    logger: "auth-proxy-logger",
    platform: "javascript",
  })
}
