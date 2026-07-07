# Changelog

## [0.13.0](https://github.com/srobroek/vibe-hero/compare/v0.12.0...v0.13.0) (2026-07-07)


### Features

* cross-session quiz arming, offer diagnostics, and tunable pacing ([#48](https://github.com/srobroek/vibe-hero/issues/48)) ([9e710dd](https://github.com/srobroek/vibe-hero/commit/9e710ddb68aa1c65964073f421f9a56c8cdebff1))
* quiz offers now trigger organically from observed tool activity ([#45](https://github.com/srobroek/vibe-hero/issues/45)) ([73b0028](https://github.com/srobroek/vibe-hero/commit/73b0028b2e400179491a82d2333d170d0e40a9fe))

## [0.12.0](https://github.com/srobroek/vibe-hero/compare/v0.11.0...v0.12.0) (2026-07-01)


### Features

* **server:** add describeCooldown() to report resolved offer-throttle config ([#43](https://github.com/srobroek/vibe-hero/issues/43)) ([129a1e7](https://github.com/srobroek/vibe-hero/commit/129a1e7edaf08e5cc62f88b147d6021a9a859b84))

## [0.11.0](https://github.com/srobroek/vibe-hero/compare/v0.10.0...v0.11.0) (2026-07-01)


### Features

* **server:** export ARM_CACHE_PREFIX for the offer-arm cache filename ([#41](https://github.com/srobroek/vibe-hero/issues/41)) ([d9a9d52](https://github.com/srobroek/vibe-hero/commit/d9a9d529315fd04970643ce7ea3b95426804691e))


### Bug Fixes

* reference path-prefixed release-please outputs so npm publish runs ([#39](https://github.com/srobroek/vibe-hero/issues/39)) ([ae0f759](https://github.com/srobroek/vibe-hero/commit/ae0f759d0bb1849c840e7f0d8715c5c1fb4f0297))

## [0.10.0](https://github.com/srobroek/vibe-hero/compare/v0.9.0...v0.10.0) (2026-07-01)


### Features

* **server:** short-circuit isWithinCooldown when the throttle is disabled ([#38](https://github.com/srobroek/vibe-hero/issues/38)) ([e8a255f](https://github.com/srobroek/vibe-hero/commit/e8a255fa613caaa97b65a2fe59a68061b459832e))


### Bug Fixes

* **ci:** publish npm in the release-please job (GITHUB_TOKEN can't trigger on:release) ([#36](https://github.com/srobroek/vibe-hero/issues/36)) ([346fdce](https://github.com/srobroek/vibe-hero/commit/346fdce233d72e4b32704ac94e9ba64d69b4dc93))

## [0.9.0](https://github.com/srobroek/vibe-hero/compare/v0.8.0...v0.9.0) (2026-07-01)


### Features

* **server:** add isThrottleDisabled() offer-cooldown predicate ([#34](https://github.com/srobroek/vibe-hero/issues/34)) ([4165b4d](https://github.com/srobroek/vibe-hero/commit/4165b4d2b51d425e035b8cb2abf31e5b353224e2))

## [0.8.0](https://github.com/srobroek/vibe-hero/compare/v0.7.0...v0.8.0) (2026-07-01)


### Features

* **server:** export offer-cooldown bound constants ([#31](https://github.com/srobroek/vibe-hero/issues/31)) ([c4cf51b](https://github.com/srobroek/vibe-hero/commit/c4cf51b9b4c4a7062cef7a6a6fb52453d8280905))

## [0.7.0](https://github.com/srobroek/vibe-hero/compare/v0.6.0...v0.7.0) (2026-07-01)


### Features

* **server:** floor a positive offer cooldown to 60s (preserve 0 = no throttle) ([#27](https://github.com/srobroek/vibe-hero/issues/27)) ([971f3ab](https://github.com/srobroek/vibe-hero/commit/971f3ab5c1d3e5f9000b82b60ae75b87f0b2e634))

## [0.6.0](https://github.com/srobroek/vibe-hero/compare/v0.5.0...v0.6.0) (2026-07-01)


### Features

* **server:** clamp offer cooldown to a 7-day maximum ([#24](https://github.com/srobroek/vibe-hero/issues/24)) ([9f6d736](https://github.com/srobroek/vibe-hero/commit/9f6d736bc8236ab7c10674478259612835e997bf))

## [0.5.0](https://github.com/srobroek/vibe-hero/compare/v0.4.1...v0.5.0) (2026-07-01)


### Features

* **plugin:** offer quizzes at inferred work breakpoints via UserPromptSubmit ([#21](https://github.com/srobroek/vibe-hero/issues/21)) ([e6a1dd2](https://github.com/srobroek/vibe-hero/commit/e6a1dd2af897b241f32f5ea803a4a1cea6064653))

## [0.4.1](https://github.com/srobroek/vibe-hero/compare/v0.4.0...v0.4.1) (2026-06-30)


### Features

* present end-of-work quiz offers silently and show a "what can you do with vibe-hero" overview right after setup ([#17](https://github.com/srobroek/vibe-hero/issues/17))


### Miscellaneous

* version-only republish of @vibe-hero/server (engine unchanged) to keep the lockstep version artifacts in sync with the plugin-only changes in #17

## [0.4.0](https://github.com/srobroek/vibe-hero/compare/v0.3.2...v0.4.0) (2026-06-30)


### Features

* server-rendered progress dashboard and a silent, throttled quiz-offer hook ([#15](https://github.com/srobroek/vibe-hero/issues/15)) ([4992b88](https://github.com/srobroek/vibe-hero/commit/4992b883482c7e5ac6cad2bc5b77a73b0cadb1ee))

## [0.3.2](https://github.com/srobroek/vibe-hero/compare/v0.3.1...v0.3.2) (2026-06-30)


### Bug Fixes

* MCP server silently does nothing when launched via npx ([#13](https://github.com/srobroek/vibe-hero/issues/13)) ([092332b](https://github.com/srobroek/vibe-hero/commit/092332b72694d5d2131bca1c582f7e37ae445060))

## [0.3.1](https://github.com/srobroek/vibe-hero/compare/v0.3.0...v0.3.1) (2026-06-30)


### Bug Fixes

* plugin fails to load — ship hooks/hooks.json and declare MCP once ([#11](https://github.com/srobroek/vibe-hero/issues/11)) ([e4eba0c](https://github.com/srobroek/vibe-hero/commit/e4eba0c3710ef26faf8b371d979c590907231bdd))

## [0.3.0](https://github.com/srobroek/vibe-hero/compare/v0.2.1...v0.3.0) (2026-06-30)


### Features

* expand catalog to 2800 items + dashboard, auto-detect, hashed remote catalog ([#8](https://github.com/srobroek/vibe-hero/issues/8)) ([8f53c4b](https://github.com/srobroek/vibe-hero/commit/8f53c4bc199e7aa71316debd20123017f342adb8))

## [0.2.1](https://github.com/srobroek/vibe-hero/compare/v0.2.0...v0.2.1) (2026-06-29)


### Bug Fixes

* keep plugin and marketplace versions in sync with npm releases ([#4](https://github.com/srobroek/vibe-hero/issues/4)) ([cbd6874](https://github.com/srobroek/vibe-hero/commit/cbd6874d0a06a3a1bbf51fd573ef4448ee9493cb))
* use repo-root-relative extra-files paths so releases can be cut ([#5](https://github.com/srobroek/vibe-hero/issues/5)) ([b456c8d](https://github.com/srobroek/vibe-hero/commit/b456c8ded0c2bc91f04bed9bde910e3d1327ba2c))

## [0.2.0](https://github.com/srobroek/vibe-hero/compare/v0.1.0...v0.2.0) (2026-06-29)


### Features

* adaptive learning MCP server that quizzes and levels up your agentic-coding skills ([#1](https://github.com/srobroek/vibe-hero/issues/1)) ([d7d3856](https://github.com/srobroek/vibe-hero/commit/d7d3856446287dd659b69e6ee8b78557c686400f))
* install vibe-hero as a one-step Claude Code plugin with automated npm releases ([#2](https://github.com/srobroek/vibe-hero/issues/2)) ([f54d856](https://github.com/srobroek/vibe-hero/commit/f54d8561fc55d3da23da737e63fa74e01cc02c4b))
