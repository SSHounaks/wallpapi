.PHONY: test coverage lint lint-eslint check

test:
	dbus-run-session -- gjs -m tests/run.mjs

coverage:
	dbus-run-session -- gjs -m scripts/coverage.mjs

lint:
	gjs -m scripts/lint.mjs

lint-eslint:
	~/.deno/bin/deno run -A npm:eslint@9 --no-config-lookup -c eslint.config.mjs .

check: lint lint-eslint
	gjs -m scripts/check.mjs
