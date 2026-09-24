import axios from 'axios';
import { randomBytes } from 'node:crypto';
import { discoverAuthentication } from './discoverAuthentication.js';

const identityFields = ['id', '_id', 'studentId', 'email', 'username', 'sub'];
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const denied = data => isObject(data) && (data.success === false || data.authenticated === false || data.valid === false || Boolean(data.error) || (Array.isArray(data.errors) && data.errors.length > 0));
const isJson = response => /\bapplication\/(?:[\w.-]+\+)?json\b/i.test(response.headers?.['content-type'] || '') && isObject(response.data);

function endpoint(target, relative) {
  const base = new URL(target);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('Use an HTTP(S) target without embedded credentials.');
  if (typeof relative !== 'string' || !relative.startsWith('/') || relative.startsWith('//')) throw new Error('Authentication endpoints must be paths beginning with /.');
  const url = new URL(relative, base.origin);
  if (url.origin !== base.origin) throw new Error('Authentication endpoints must belong to the configured target.');
  return url;
}

function identity(data) {
  const candidates = [data?.user, data?.account, data?.profile, data?.data?.user, data];
  for (const candidate of candidates) {
    if (!isObject(candidate)) continue;
    const fields = Object.fromEntries(identityFields.filter(key => ['string', 'number'].includes(typeof candidate[key]) && String(candidate[key]).trim()).map(key => [key, candidate[key]]));
    if (Object.keys(fields).length) return fields;
  }
  return null;
}

// Honor cookie scope on the verification request; never send Set-Cookie attributes as cookies.
function sessionCookies(values, loginUrl, verifyUrl) {
  const cookies = [];
  for (const raw of Array.isArray(values) ? values : values ? [values] : []) {
    const [pair, ...attributes] = raw.split(';').map(part => part.trim());
    if (!/^[^=\s]+=[^\r\n]*$/.test(pair) || pair.endsWith('=')) continue;
    const attrs = Object.fromEntries(attributes.map(attr => { const split = attr.indexOf('='); return split < 0 ? [attr.toLowerCase(), true] : [attr.slice(0, split).toLowerCase(), attr.slice(split + 1)]; }));
    const domain = typeof attrs.domain === 'string' ? attrs.domain.replace(/^\./, '').toLowerCase() : loginUrl.hostname;
    if (loginUrl.hostname !== domain && !loginUrl.hostname.endsWith('.' + domain)) continue;
    if (verifyUrl.hostname !== domain && !verifyUrl.hostname.endsWith('.' + domain)) continue;
    if (attrs.secure && verifyUrl.protocol !== 'https:') continue;
    if (attrs['max-age'] !== undefined ? Number(attrs['max-age']) <= 0 : attrs.expires && Date.parse(attrs.expires) <= Date.now()) continue;
    const cookiePath = typeof attrs.path === 'string' && attrs.path.startsWith('/') ? attrs.path : loginUrl.pathname.slice(0, loginUrl.pathname.lastIndexOf('/')) || '/';
    if (verifyUrl.pathname !== cookiePath && !(verifyUrl.pathname.startsWith(cookiePath) && (cookiePath.endsWith('/') || verifyUrl.pathname[cookiePath.length] === '/'))) continue;
    cookies.push(pair);
  }
  return cookies.join('; ');
}

export function normalizeCookie(value) {
  const text = String(value || '').trim().replace(/^Cookie:\s*/i, '');
  if (!text || /[\r\n\x00-\x1f\x7f]/.test(text)) throw new Error('Paste a single Cookie header containing name=value pairs.');
  const pairs = text.split(';').map(part => part.trim()).filter(Boolean);
  const attributes = /^(?:path|domain|expires|max-age|samesite|secure|httponly|partitioned)$/i;
  for (const pair of pairs) {
    const split = pair.indexOf('=');
    if (split < 1 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(pair.slice(0, split)) || attributes.test(pair.slice(0, split))) {
      throw new Error('Paste the request Cookie header, not Set-Cookie attributes or a browser cookie table.');
    }
  }
  return pairs.join('; ');
}

export async function verifyAuthentication(options, http = axios) {
  const evidence = [];
  const type = options.bearer ? 'Bearer token' : options.cookie ? 'Session cookie' : options.authId !== undefined && options.authId !== '' ? 'Login ID' : options.email || options.password ? 'Credentials' : 'unauthenticated';
  const outcome = (status, detail, extra = {}) => ({ valid: status === 'SUCCESS' || status === 'PUBLIC', authenticated: status === 'SUCCESS', status, type, detail, error: ['FAILED', 'UNVERIFIED'].includes(status) ? detail : null, evidence, ...extra });
  if (type === 'unauthenticated') return outcome('PUBLIC', 'No authentication requested.');
  const requestOptions = { timeout: 8000, maxRedirects: 0, validateStatus: () => true };
  const record = (step, url, response) => evidence.push({ step, endpoint: url.origin + url.pathname, httpStatus: response.status });
  let discovery;
  try { discovery = await discoverAuthentication(options); }
  catch { return outcome('UNVERIFIED', 'Authentication discovery could not be completed.'); }
  options = { ...options, authIdField: options.authIdField || discovery.authIdField };
  if (type === 'Login ID' && !options.authIdField) return outcome('UNVERIFIED', 'Could not determine a unique login ID field from the repository. No login request was sent.');
  let verifyUrl, loginUrl;
  let verificationUrls;
  let receivedCookies;
  try {
    verificationUrls = (options.authVerifyPath ? [options.authVerifyPath] : discovery.verificationPaths).map(value => endpoint(options.target, value));
    if (['Login ID', 'Credentials'].includes(type)) loginUrl = endpoint(options.target, options.authLoginPath || '/api/auth/login');
  } catch (error) { return outcome('UNVERIFIED', error.message); }
  let bearer = typeof options.bearer === 'string' ? options.bearer.replace(/^Bearer\s+/i, '').trim() : '';
  let cookie = '';
  try { if (options.cookie) cookie = normalizeCookie(options.cookie); }
  catch (error) { return outcome('FAILED', error.message); }
  if (loginUrl) {
    const field = options.authIdField || 'studentId';
    if (!/^[a-zA-Z][\w]{0,63}$/.test(field) || ['__proto__', 'constructor', 'prototype'].includes(field)) return outcome('UNVERIFIED', 'Invalid login ID field name.');
    if (type === 'Credentials' && (!options.email || !options.password)) return outcome('FAILED', 'Both email and password are required.');
    const payload = type === 'Login ID' ? { [field]: options.authId } : { email: options.email, password: options.password };
    let response;
    try { response = await http.post(loginUrl.href, payload, requestOptions); }
    catch { return outcome('UNVERIFIED', 'Login request could not be completed. No session was verified.'); }
    record('Login', loginUrl, response);
    if ([400, 401, 403, 422].includes(response.status) || denied(response.data)) return outcome('FAILED', 'The login endpoint rejected the supplied input or credentials.');
    if (response.status < 200 || response.status >= 300) return outcome('UNVERIFIED', 'Login did not return a successful API response. Check the configured endpoint; redirects are not followed.');
    if (!isJson(response)) return outcome('UNVERIFIED', 'Login returned a page or non-JSON response. HTTP success alone is not authentication.');
    if (response.data.firstLogin === true) return outcome('UNVERIFIED', 'The server returned a first-login/onboarding response. This does not prove an authenticated session.');
    const token = response.data.token || response.data.accessToken || response.data.access_token;
    if (typeof token === 'string') bearer = token.trim();
    receivedCookies = response.headers?.['set-cookie'];
  }
  if (!bearer && !cookie && !receivedCookies) return outcome('UNVERIFIED', 'No usable session token or cookie was returned. A user lookup is not session verification.');
  const pastedCookie = cookie;
  let lastResult;
  for (verifyUrl of verificationUrls) {
    cookie = receivedCookies ? sessionCookies(receivedCookies, loginUrl, verifyUrl) : pastedCookie;
    if (!bearer && !cookie) continue;
    const check = async () => {
      const headers = { Accept: 'application/json' };
      if (bearer) headers.Authorization = `Bearer ${bearer}`;
      if (cookie) headers.Cookie = cookie;
      const invalidValue = `codestress-invalid-${randomBytes(16).toString('hex')}`;
      const invalidHeaders = { Accept: 'application/json' };
      if (bearer) invalidHeaders.Authorization = `Bearer ${invalidValue}`;
      if (cookie) invalidHeaders.Cookie = cookie.split(';').map(pair => pair.trim().split('=')[0]).filter(Boolean).map(name => `${name}=${invalidValue}`).join('; ');
      let anonymous, invalid, authenticated;
      try {
        anonymous = await http.get(verifyUrl.href, { ...requestOptions, headers: { Accept: 'application/json' } });
        record('Without credentials', verifyUrl, anonymous);
        if (!options.authVerifyPath && ![401, 403].includes(anonymous.status)) return outcome('UNVERIFIED', 'Candidate does not reject anonymous access.');
        invalid = await http.get(verifyUrl.href, { ...requestOptions, headers: invalidHeaders });
        record('With invalid credentials', verifyUrl, invalid);
        if (!options.authVerifyPath && ![401, 403].includes(invalid.status)) return outcome('UNVERIFIED', 'Candidate accepts invalid credentials.');
        authenticated = await http.get(verifyUrl.href, { ...requestOptions, headers });
        record('With credentials', verifyUrl, authenticated);
      } catch { return outcome('UNVERIFIED', 'The session verification request failed or timed out. No authenticated access was confirmed.'); }
      if ([401, 403].includes(authenticated.status) || denied(authenticated.data)) return outcome('FAILED', 'The verification endpoint rejected authenticated access.');
      if (![401, 403].includes(anonymous.status)) return outcome('UNVERIFIED', 'The verification endpoint did not deny anonymous access with HTTP 401/403. This candidate cannot establish a protected session.');
      if (![401, 403].includes(invalid.status)) return outcome('UNVERIFIED', 'The verification endpoint did not reject deliberately invalid credentials. Authentication cannot be trusted from this endpoint.');
      if (authenticated.status < 200 || authenticated.status >= 300 || !isJson(authenticated)) return outcome('UNVERIFIED', 'The authenticated request did not return a successful JSON session response.');
      const user = identity(authenticated.data);
      if (!user) return outcome('UNVERIFIED', 'The verification response did not identify an authenticated user.');
      const expectedField = type === 'Login ID' ? options.authIdField || 'studentId' : type === 'Credentials' ? 'email' : null;
      const expectedValue = type === 'Login ID' ? options.authId : options.email;
      if (expectedField && (user[expectedField] === undefined || String(user[expectedField]) !== String(expectedValue))) return outcome('UNVERIFIED', 'The verification response did not match the supplied account identity.');
      return outcome('SUCCESS', 'Protected session endpoint denied anonymous and invalid credentials, then returned the matching authenticated account with the supplied session.', { user, session: { bearer, cookie } });
    };
    lastResult = await check();
    if (lastResult.status === 'SUCCESS') return lastResult;
    if (options.authVerifyPath) return lastResult;
  }
  return outcome('UNVERIFIED', 'Automatic discovery could not verify a protected current-user endpoint. The session may be expired, the API may use a different origin, or this app may not expose a supported session endpoint.');
}
