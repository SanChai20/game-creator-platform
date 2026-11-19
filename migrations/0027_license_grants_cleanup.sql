-- Creator licenses, cleanup after 0026. Since 0026 an account's license is recomputed from its paid grants (payments rows,
-- kind creator_fee). Two kinds of older records did not fit that:
--
-- 1. A license an admin removed before 0026: the old Remove only set users.creator = 0 and left the grant marked paid.
--    The next recompute (buying a license, a refund) brought it back, so an account that bought a one-year license was
--    shown as lifetime. Those grants are marked revoked.
-- 2. A license given without a payments row (the first admin's claim before 0026): it held only while nothing recomputed
--    the license. It gets a lifetime grant on record, as 0026 already treated it.
UPDATE payments SET status = 'revoked'
  WHERE kind = 'creator_fee' AND status = 'paid' AND user_id IN (SELECT id FROM users WHERE creator = 0);

INSERT INTO payments (id, user_id, kind, amount_cents, provider, provider_ref, status, plan, expires_at, created_at)
  SELECT 'pay_legacy_' || u.id, u.id, 'creator_fee', 0, 'admin', 'legacy:' || u.id, 'paid', 'lifetime', NULL, COALESCE(u.creator_since, u.created_at)
  FROM users u
  WHERE u.creator = 1 AND COALESCE(u.creator_plan, 'lifetime') = 'lifetime'
    AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.user_id = u.id AND p.kind = 'creator_fee' AND p.status = 'paid');
