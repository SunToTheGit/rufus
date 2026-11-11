'use strict';
// Netlify entry point for the plain-website version of SunFlix. All the logic is in lib/cloud.js.
const { handle } = require('../../lib/cloud');

exports.handler = async (event) => {
  const out = await handle({
    method: event.httpMethod,
    path: event.path,
    query: event.queryStringParameters || {},
    headers: event.headers || {},
    body: event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body,
  });
  return { statusCode: out.status, headers: out.headers, body: out.body };
};
