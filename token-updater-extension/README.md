# Flow2API Token Updater

This standalone extension keeps the token-based integration separate from the
bundled `extension/` WebSocket/browser worker.

1. Open `chrome://extensions`, enable Developer mode, and load this directory.
2. Copy the connection URL and connection token from the Flow2API admin page.
3. Sign in to Google Flow in the same Chrome profile.
4. Save the settings and run the immediate test.

The updater first uses the legacy Labs `session-token` cookie when it exists.
When Google Flow no longer creates that cookie, it sends only the Google cookies
required by the server's protocol-login exchange. The server then obtains and
validates a real session token before updating or adding the Flow2API token.
