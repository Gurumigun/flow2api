import unittest
from src.services.browser_captcha_extension import ExtensionCaptchaError, ExtensionCaptchaService


class ImageResultVersionTests(unittest.TestCase):
    def test_old_image_workers_are_blocked_before_dispatch(self):
        for version in ('', 'invalid', '1.3.20', '1.3.24', '1.3.28', '1.3.29', '1.3.30', '1.3.31', '1.3.32', '1.3.33', '1.3.34', '1.3.35', '1.3.36', '1.3.37', '1.3.38'):
            with self.subTest(version=version):
                with self.assertRaises(ExtensionCaptchaError) as caught:
                    ExtensionCaptchaService._require_image_ui_version(version)
                self.assertEqual(caught.exception.code, 'extension_reload_required')

    def test_validating_workers_are_accepted(self):
        for version in ('1.3.39', '1.4.0', '2.0.0'):
            ExtensionCaptchaService._require_image_ui_version(version)

    def test_video_worker_requires_extended_wait_support(self):
        for version in ('1.3.30', '1.3.31', '1.3.39'):
            with self.assertRaises(ExtensionCaptchaError):
                ExtensionCaptchaService._require_video_ui_version(version)
        ExtensionCaptchaService._require_video_ui_version('1.3.40')
