import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from src.api import admin
from src.core.models import Token
from src.services.load_balancer import LoadBalancer


class PluginTokenUpdateTests(unittest.IsolatedAsyncioTestCase):
    def _build_dependencies(self, *, expires: datetime, auto_enable: bool = True):
        existing = Token(
            id=7,
            st="old-session",
            at="old-access",
            at_expires=datetime.now(timezone.utc) - timedelta(hours=1),
            email="account@example.com",
            is_active=False,
            browser_enabled=False,
            extension_route_key="profile-7",
        )
        plugin_config = SimpleNamespace(
            connection_token="connection-secret",
            auto_enable_on_update=auto_enable,
        )
        database = SimpleNamespace(
            get_plugin_config=AsyncMock(return_value=plugin_config),
            get_token_by_email=AsyncMock(return_value=existing),
            update_token=AsyncMock(),
        )
        manager = SimpleNamespace(
            flow_client=SimpleNamespace(
                st_to_at=AsyncMock(return_value={
                    "access_token": "fresh-access",
                    "expires": expires.isoformat(),
                    "user": {"email": existing.email},
                })
            ),
            update_token=AsyncMock(),
            set_browser_connection_enabled=AsyncMock(return_value=(existing, True)),
        )
        return existing, database, manager

    async def test_expired_plugin_credentials_are_rejected_before_update(self):
        _, database, manager = self._build_dependencies(
            expires=datetime.now(timezone.utc) - timedelta(minutes=1),
        )

        with patch.object(admin, "db", database), patch.object(admin, "token_manager", manager):
            with self.assertRaises(HTTPException) as raised:
                await admin.plugin_update_token(
                    {"session_token": "stale-session"},
                    "Bearer connection-secret",
                )

        self.assertEqual(raised.exception.status_code, 400)
        self.assertIn("expired access token", raised.exception.detail)
        manager.update_token.assert_not_awaited()

    async def test_auto_enable_restores_browser_switch_with_fresh_credentials(self):
        existing, database, manager = self._build_dependencies(
            expires=datetime.now(timezone.utc) + timedelta(hours=2),
        )

        with patch.object(admin, "db", database), patch.object(admin, "token_manager", manager):
            result = await admin.plugin_update_token(
                {"session_token": "fresh-session"},
                "Bearer connection-secret",
            )

        self.assertTrue(result["auto_enabled"])
        self.assertTrue(
            manager.update_token.await_args.kwargs["reactivate_on_credential_update"]
        )
        manager.set_browser_connection_enabled.assert_awaited_once_with(existing.id, True)
        database.update_token.assert_awaited_once_with(
            existing.id,
            browser_session_sync_pending=False,
        )

    async def test_disabled_auto_enable_preference_is_honored(self):
        _, database, manager = self._build_dependencies(
            expires=datetime.now(timezone.utc) + timedelta(hours=2),
            auto_enable=False,
        )

        with patch.object(admin, "db", database), patch.object(admin, "token_manager", manager):
            result = await admin.plugin_update_token(
                {"session_token": "fresh-session"},
                "Bearer connection-secret",
            )

        self.assertNotIn("auto_enabled", result)
        self.assertFalse(
            manager.update_token.await_args.kwargs["reactivate_on_credential_update"]
        )
        manager.set_browser_connection_enabled.assert_not_awaited()

    async def test_google_cookies_are_exchanged_when_labs_cookie_is_missing(self):
        _, database, manager = self._build_dependencies(
            expires=datetime.now(timezone.utc) + timedelta(hours=2),
        )
        google_cookies = '[{"name":"SID","value":"google-session"}]'

        with (
            patch.object(admin, "db", database),
            patch.object(admin, "token_manager", manager),
            patch(
                "src.services.protocol_login.protocol_loginer.login",
                new=AsyncMock(return_value={
                    "success": True,
                    "session_token": "protocol-session",
                }),
            ) as protocol_login,
        ):
            result = await admin.plugin_update_token(
                {
                    "google_cookies": google_cookies,
                    "login_account": "account@example.com",
                },
                "Bearer connection-secret",
            )

        self.assertEqual(result["action"], "updated")
        protocol_login.assert_awaited_once_with(
            google_cookies,
            proxy=None,
            email="account@example.com",
        )
        manager.flow_client.st_to_at.assert_awaited_once_with("protocol-session")
        self.assertEqual(
            manager.update_token.await_args.kwargs["st"],
            "protocol-session",
        )
        self.assertEqual(
            manager.update_token.await_args.kwargs["protocol_mode"],
            "protocol",
        )
        self.assertEqual(
            manager.update_token.await_args.kwargs["google_cookies"],
            google_cookies,
        )

    async def test_invalid_google_cookies_are_rejected_before_st_exchange(self):
        _, database, manager = self._build_dependencies(
            expires=datetime.now(timezone.utc) + timedelta(hours=2),
        )

        with (
            patch.object(admin, "db", database),
            patch.object(admin, "token_manager", manager),
            patch(
                "src.services.protocol_login.protocol_loginer.login",
                new=AsyncMock(return_value={
                    "success": False,
                    "error": "Google session expired",
                }),
            ),
        ):
            with self.assertRaises(HTTPException) as raised:
                await admin.plugin_update_token(
                    {"google_cookies": '[{"name":"SID","value":"expired"}]'},
                    "Bearer connection-secret",
                )

        self.assertEqual(raised.exception.status_code, 400)
        self.assertIn("Google session expired", raised.exception.detail)
        manager.flow_client.st_to_at.assert_not_awaited()

    async def test_plugin_update_requires_session_or_google_cookies(self):
        _, database, manager = self._build_dependencies(
            expires=datetime.now(timezone.utc) + timedelta(hours=2),
        )

        with patch.object(admin, "db", database), patch.object(admin, "token_manager", manager):
            with self.assertRaises(HTTPException) as raised:
                await admin.plugin_update_token({}, "Bearer connection-secret")

        self.assertEqual(raised.exception.status_code, 400)
        self.assertEqual(
            raised.exception.detail,
            "Missing session_token or google_cookies",
        )


class _UnavailableTokenManager:
    def __init__(self, tokens):
        self.tokens = tokens

    async def get_active_tokens(self):
        return [token for token in self.tokens if token.is_active]

    async def get_all_tokens(self):
        return self.tokens


class UnavailableReasonTests(unittest.IsolatedAsyncioTestCase):
    async def test_inactive_pool_reports_paused_and_expired_counts(self):
        expired_at = datetime.now(timezone.utc) - timedelta(hours=1)
        tokens = [
            Token(
                id=token_id,
                st=f"session-{token_id}",
                at=f"access-{token_id}",
                at_expires=expired_at,
                email=f"account-{token_id}@example.com",
                is_active=False,
                browser_enabled=False,
            )
            for token_id in range(1, 5)
        ]
        reason = await LoadBalancer(
            _UnavailableTokenManager(tokens)
        ).get_unavailable_reason(for_image_generation=True)

        self.assertIn("共 4 个Token", reason)
        self.assertIn("浏览器连接已关闭 4 个", reason)
        self.assertIn("AT缺失或已过期 4 个", reason)


if __name__ == "__main__":
    unittest.main()
