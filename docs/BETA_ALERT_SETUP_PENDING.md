# Beta alert delivery setup — 2026-10-15

Reviewed timestamp/auth patch deployed with explicit approval. Both forward migrations applied before the function deploy. beta-monitor authenticates the existing x-cron-secret or service-role bearer, never a user token; gateway JWT verification is disabled for this internally authenticated endpoint. Anonymous production test request returned 403.

Approved non-secret production settings: SMTP_HOST=smtp.resend.com, SMTP_PORT=465, SMTP_USER=resend, SMTP_FROM=PaperTrellis <team@mail.papertrellis.com>, BETA_ALERT_RECIPIENT=caivory03@gmail.com. BETA_ALERTS_ENABLED=false; private.beta_alert_config.enabled=false.

The user saved SMTP_Password (mixed case). The runtime supports that spelling as a fallback to SMTP_PASSWORD. Only presence was inspected; credentials were not read, copied, entered, or changed. Supabase Auth SMTP credential was not used.

Single controlled test: subject “Verastar: alert delivery test”, observed 2026-10-15 22:39:49.864457 UTC, SMTP acceptance saved at 22:39:51.204333 UTC. Internal request 5889 returned HTTP 200, delivery=sent, no timeout. This confirms provider acceptance, not inbox receipt. Atomic service-only test claim prevents repeat sends; failed or uncertain attempts must not be automatically retried. Payload contains only status, UTC time, fixed dashboard URL.

Cron job 3 verastar-beta-alert-dispatch invokes the endpoint every five minutes using the existing Vault reference verastar_digest_cron_secret internally. Existing database-only monitor job 2 and digest job 1 are unchanged. No credential value is stored in the cron command. Routine delivery remains disabled pending receipt confirmation. Enable both runtime and database flags only after parent approval; no routine success messages.

Validation: independent review without blockers; 135 test files, 2589 passed, 3 expected fail, 15 todo; disposable SQL suite passed including test claim dedupe and anonymous denial; lint no new diagnostics (baseline 9 errors/9 warnings). Security advisors show no new alert-function access finding; unrelated existing findings remain unchanged.
