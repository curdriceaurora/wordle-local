# Third-Party Notices

## English Dictionary

This project includes the `wordlist-en_US-2020.12.07` English word list (Hunspell dictionary derived from SCOWL). The upstream license and credits are provided in `data/dictionaries/wordlist-en_US-2020.12.07-README.txt`.

## English Definitions

This project includes derived English definitions in `data/dictionaries/en-definitions.json`, generated from Princeton WordNet 3.1 data via `wordnet-db`.

- WordNet license text: `data/dictionaries/wordnet-3.1-LICENSE.txt`
- Generator script: `scripts/build-en-definitions.js`

## Chart.js

The admin Analytics tab renders charts with Chart.js v4 (MIT). The UMD
bundle is vendored locally at `public/dist/vendor/chart.umd.min.js` so
the admin shell makes no external network calls; the upstream license
text is checked in next to the bundle at
`public/dist/vendor/chart.js-LICENSE.md`.

- Project: https://www.chartjs.org/
- License: MIT (Copyright (c) 2014-2024 Chart.js Contributors)

## web-push

Daily-puzzle Web Push notifications use the `web-push` Node package
to sign VAPID JWTs (RFC 8292) and encrypt RFC 8291 push messages.
Required because Node ships VAPID-capable transport but does not
expose the lower-level `aes128gcm` content encoding helpers needed
for RFC 8291 message bodies.

- Project: https://github.com/web-push-libs/web-push
- License: MPL-2.0 (Mozilla Public License 2.0)
- Source obligation: distributing modified versions of `web-push` (or
  any covered file) requires making that modified source available to
  recipients under MPL-2.0. We use the upstream package unmodified;
  any future fork/patch must preserve this disclosure.
