# Security and personal-data sweep

Run on 11 Nov 2026, before the first push, over exactly the files in the commit (an export of the git index, 115
files) and over the git history.

## gitleaks

`gitleaks 8.30.1`, default rules, `--redact`:

| Scan | Result |
| --- | --- |
| `gitleaks detect --no-git` over the exported tree | no leaks found (about 2.06 MB scanned) |
| `gitleaks detect` over the git history | no leaks found |

## Personal-data regex sweep

A second pass for the things gitleaks does not look for: home-network addresses, device identifiers, names, paths
and the project's own history. Counts are matches in text files; every match is listed and explained below.

| Check | Matches |
| --- | --- |
| Private LAN address outside the documented `192.168.1.x` examples | 10, all test fixtures (below) |
| The source project's real subnet | 0 |
| Tailscale / CGNAT address other than the RFC 6598 fixture `100.64.0.5` | 1, a test fixture (below) |
| MAC address other than the locally administered test MAC `02:00:00:00:00:01` | 2, a zeroed fixture (below) |
| E-mail address (other than `example.*` and `noreply`) | 0 |
| The author's name, handle or machine names | 0 |
| Windows user paths (`C:\Users\<name>`) | 0 |
| Real bus stop codes or roads from the source project | 1, a public list (below) |
| Claude artifact or share URLs | 0 |
| Lively / wallpaper-host references | 0 |
| Secret-looking assignments | 1, a fake URL in a test (below) |
| Private key blocks | 0 |

Files that must not exist, checked by path:

| Check | Result |
| --- | --- |
| Keystores, `.env`, `.key`, `.pem`, `.p12` | none |
| `hub/state/`, `data/`, `devices/`, `plates-4k/`, `masters/`, `refs/`, `icons/`, `models/` | none |
| Images | only `docs/screens/*` (screenshots of the demo hub), the two placeholder plates drawn by `tools/make-placeholder.py`, and the APK's banner and icon drawn by `tools/tv-dream/make-art.py` (the Claude tile is a drawn "C" monogram, not Anthropic's logo) |

### Every remaining match, explained

- `hub/test/net-guard.test.mjs`: `10.0.0.1`, `10.255.255.255`, `172.16.0.1`, `172.31.255.254`, `192.168.0.1`,
  `10.1.2.3`, `100.64.0.1`. The edges of the RFC 1918 and RFC 6598 ranges, testing that the hub accepts LAN callers.
- `hub/test/poco-battery.test.mjs`: `10.0.0.9`, a made-up phone address.
- `hub/test/tv-power.test.mjs`: `192.168.58.1` and `10.0.0.5`, made-up VMware and other adapters, testing that a
  Wake-on-LAN packet leaves from the TV's subnet.
- `tools/tv-dream/test/.../CoreTest.java`: `192.168.2.1`, an address the app must refuse.
- `hub/test/wearables.test.mjs`: `00:00:00:00:00:0B`, a zeroed Bluetooth address in a sample `dumpsys` report.
- `tv-setup.html`: "Bishan" appears once, in the full list of NEA's public forecast areas.
- `hub/test/next.test.mjs`: `https://calendar.example/ical/me%40example.com/private-…/basic.ics`, a fake calendar
  address that tests the hub never logs it.

## What was taken out before publishing

- The laptop side: the wallpaper host, the device agent, the always-on lock helper and their tests.
- Everything personal: real LAN addresses (now `TV_SERIAL`, `TV_MAC`, `TV_BROADCAST`, `--hub`, `--mirror`), the TV's
  MAC address, bus stops (now `hub/state/bus.json`), the author's design notes on their own paintings, sample phone
  names, quoted conversations in comments.
- All third-party art: the paintings, the app icons, the 4K masters and the reference images.
