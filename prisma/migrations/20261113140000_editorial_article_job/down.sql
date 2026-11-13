-- PostgreSQL cannot remove a value from an enum safely; removing it would break
-- rows that already use it, so the value stays harmlessly unused on rollback.
SELECT 1;
