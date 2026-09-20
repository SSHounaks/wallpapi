.PHONY: test lint coverage check

test:
	dbus-run-session -- gjs -m tests/run.mjs

coverage:
	dbus-run-session -- gjs -m scripts/coverage.mjs

lint:
	gjs -m scripts/lint.mjs

check:
	gjs -m scripts/check.mjs
