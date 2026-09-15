import json
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
EXTENSION_ROOT = REPO_ROOT / "token-updater-extension"


class TokenUpdaterExtensionContractTests(unittest.TestCase):
    def test_manifest_can_read_current_google_flow_cookies(self):
        manifest = json.loads((EXTENSION_ROOT / "manifest.json").read_text())

        self.assertEqual(manifest["name"], "Flow2API Token Updater")
        self.assertGreaterEqual(
            tuple(int(part) for part in manifest["version"].split(".")),
            (1, 1, 0),
        )
        self.assertIn("cookies", manifest["permissions"])
        self.assertIn("https://flow.google.com/*", manifest["host_permissions"])
        self.assertIn("https://*.google.com/*", manifest["host_permissions"])
        self.assertNotIn("https://*/*", manifest["host_permissions"])
        self.assertIn("https://*/*", manifest["optional_host_permissions"])

    def test_background_falls_back_to_protocol_cookie_exchange(self):
        background = (EXTENSION_ROOT / "background.js").read_text()

        self.assertIn('"__Secure-next-auth.session-token"', background)
        self.assertIn('"next-auth.session-token"', background)
        self.assertIn('"SID"', background)
        self.assertIn('"SAPISID"', background)
        self.assertIn("google_cookies: parsedGoogleCookies.length ? googleCookies : null", background)
        self.assertIn('protocol_mode: parsedGoogleCookies.length ? "protocol" : "session"', background)
        self.assertNotIn("console.log", background)

    def test_popup_keeps_token_updater_configuration_separate(self):
        popup = (EXTENSION_ROOT / "popup.html").read_text()
        popup_script = (EXTENSION_ROOT / "popup.js").read_text()

        self.assertIn("/api/plugin/update-token", popup)
        self.assertIn('id="connectionToken"', popup)
        self.assertNotIn("captcha_ws", popup)
        self.assertIn("chrome.permissions.request", popup_script)


if __name__ == "__main__":
    unittest.main()
