# Content Security Policy

The server sets `Content-Security-Policy` on every response via
[helmet](https://helmetjs.github.io/) (see `server.js`).

## Active policy

| Directive | Value | Rationale |
| --- | --- | --- |
| `default-src` | `'self'` | Deny all unspecified content sources by default |
| `base-uri` | `'self'` | Prevent `<base>` hijacking |
| `form-action` | `'self'` | Restrict form submissions to same-origin |
| `frame-ancestors` | `'self'` | Prevent clickjacking from cross-origin frames |
| `font-src` | `'self' https: data:` | Self-hosted fonts + preloaded woff2 data URIs |
| `img-src` | `'self' data:` | Favicon / inline image data URIs |
| `object-src` | `'none'` | Block plugin-executed content (Flash, etc.) |
| `script-src` | `'self' 'unsafe-inline'` | See note below |
| `script-src-attr` | `'none'` | Block inline event handlers (`onclick=`, etc.) |
| `style-src` | `'self' https:` | No inline styles; external sheets only |
| `upgrade-insecure-requests` | disabled | See note below |

## Notes

### `script-src 'unsafe-inline'`

Two synchronous pre-paint scripts in `public/index.html` and
`public/admin/index.html` read `localStorage` to apply the stored theme
and locale **before** the stylesheet downloads. Making them `defer` (or
moving them to external files) would re-introduce a flash of
unstyled/wrong-theme content on load.

The correct long-term fix is nonce-based CSP, which requires the server to
inject a unique nonce into the HTML template on each request and include
it in the `script-src` directive. That upgrade is tracked separately.

Until then, the policy intentionally allows `'unsafe-inline'` in
`script-src`. Note that `script-src-attr: 'none'` still blocks inline
event handlers, which covers the most common XSS injection points.

### `upgrade-insecure-requests` disabled

Chromium and Firefox exempt loopback from this directive, but WebKit does
not — it attempts `https://localhost:<port>/<asset>` and fails the TLS
handshake, breaking every subresource on an HTTP-only local deployment.
Add `upgrade-insecure-requests` at the reverse-proxy layer (or under a
`NODE_ENV` gate) when deploying behind HTTPS termination.

## Testing

`tests/csp-headers.integration.test.js` asserts that `GET /` and
`GET /admin` both return the header and that `style-src` carries no
`'unsafe-inline'`.
