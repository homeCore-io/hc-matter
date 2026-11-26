# hc-matter

Matter devices in [homeCore](https://github.com/homeCore-io/homeCore): lights,
plugs, locks, blinds, thermostats, fans and sensors, from any maker, over Wi-Fi,
Ethernet or Thread.

homeCore becomes a Matter controller of its own. A device can be in homeCore
and in Apple Home, Google Home or Alexa at once (Matter's "multi-admin"): pair
it in its usual app, choose that app's option to share it, and pair the code
that gives you here.

## How it works

```
homeCore ── MQTT ── hc-matter ── unix socket ── matter-server ── Matter ── devices
                    (this plugin)               (child process)
```

- **[matter-server](https://github.com/matter-js/matterjs-server)**, the Open
  Home Foundation's Matter controller (the one Home Assistant uses), does the
  Matter work: the fabric, pairing, subscriptions, commands. hc-matter ships a
  pinned version and runs it as a child process, listening on a unix socket in
  the plugin's data directory and nowhere else. Its dashboard is off. It is
  restarted with backoff if it stops, and it stops when the plugin does, even
  when the plugin is killed outright.
- **hc-matter** turns what it reports into homeCore devices in homeCore's names
  and units, and homeCore's commands into Matter commands.
- **The fabric** (the keys every paired device trusts, and the list of devices)
  is kept in `data/matter-server/`, beside the plugin's installed versions, so
  updates and rollbacks keep it. Back it up: losing it means pairing every
  device again.

It runs in a homeCore **Node.js plugin runtime**. The runtime gets Node.js from
homeCore's registry, like a Python runtime gets Python.

### What the runtime needs

Matter finds devices with mDNS over IPv6 link-local multicast, and Thread
devices are reached through routes their border routers advertise. So the
runtime must use the **host's network** (`network_mode: host`), on a host with
IPv6, on the same network as the devices. A runtime in a bridged container
network cannot reach any device.

## Pairing

On the plugin's page in homeCore (Settings › Plugins › Matter), enter the
device's setup code: the text of its QR code (`MT:…`), or its 11- or 21-digit
code. Progress shows as it goes, then the devices it brought.

Pairing is over the network only. That means:

- **A device already in another app:** in that app, choose to share it
  (Apple Home: *Turn On Pairing Mode*; Google Home: *Linked Matter apps &
  services*; Alexa: *Other assistants and apps*), and pair the new code it
  shows.
- **A Wi-Fi or Ethernet device that is already on the network:** pair its
  code.
- **A brand-new device that has to be set up over Bluetooth** can't be paired
  here yet. Set it up in its usual app first, then share it.

## The plugin's page

The page lists every paired Matter device (a "node"): whether it answers, what
it is, its firmware, and the homeCore devices it became. For each one:

- **Share** opens it to another app for 15 minutes and shows a QR code and a
  manual code to add it there. It stays in homeCore.
- **Shared with** lists the controllers it is paired with (Apple Home, Google
  Home, …), and removes any of them but homeCore.
- **Check firmware** asks whether a newer firmware is published, and installs
  it if you say so; progress shows on the device.
- **Read again** asks the device again what it has (after a firmware update).
- **Remove** takes it out of homeCore and off this controller. Other apps it
  is shared with keep it.

*Networks for new devices* holds the Wi-Fi network and the Thread dataset that
a device joins when it is paired before it is on any network. A device shared
from another app needs neither.

Each of these is also a plugin action, for automations, hc-mcp or the API.
Everything that pairs or unpairs, opens a device to another app, changes
firmware or sets network secrets is for admins only (`requires_role: admin`):

| Action | Takes | Answers |
|---|---|---|
| `pair` (streaming) | `code` | progress, one item per device, then `node_id` and `devices` |
| `nodes` | | `nodes`: each node, its state and its devices |
| `server_status` | | whether matter-server runs, its version, Wi-Fi/Thread set |
| `share_node` | `node_id` | `manual_code`, `qr_code`, `expires_in_secs` |
| `fabrics` | `node_id` | `fabrics`, this controller's marked |
| `remove_fabric` | `node_id`, `fabric_index` | |
| `reinterview` | `node_id` | |
| `check_update` | `node_id` | `available`, `version`, `version_string` |
| `update_firmware` | `node_id`, `version` | |
| `remove_node` | `node_id` | |
| `set_wifi` | `ssid`, `password` | |
| `set_thread_dataset` | `dataset` (hex) | |

## Sharing homeCore devices with other apps (the bridge)

The other way round: homeCore's own devices, from any plugin, shown to Apple
Home, Google Home, Alexa or any Matter app as one Matter bridge. Lights,
switches, locks, blinds and covers, thermostats, fans, and contact,
occupancy, temperature, humidity, leak and light sensors.

- **Off until you turn it on**, under *Share with other apps* on the plugin's
  page. It then shows a QR code and a code to pair "homeCore" in the other
  app. The bridge is not a certified Matter product, so the app may warn
  before adding it. To add it to a second app, share it from the first, as
  for any Matter device.
- **Only the devices you choose.** Nothing is shared until it is ticked, and a
  device added to homeCore later stays private until then. Devices that came
  from Matter are never offered: pair those in the other app directly.
- **Locks, and covers that are garage doors, gates or doors** (anything
  homeCore counts as security and that can be commanded), can be shared only
  after a warning: the other app's users and its voice assistant could then
  unlock or open them, without homeCore asking.
- Changes go both ways: the other app's commands become homeCore commands
  (the plugin's own API key, `devices:command`), and homeCore's state shows
  in the other app. A dimmer's fade is sent as one command.
- **A thermostat is what it is in homeCore**: heating, cooling or both (with
  auto only when it has both), its own setpoint limits, and only the modes it
  takes. A single `setpoint` (NuHeat) shows as heating. A fan's on and speed
  show as Matter's fan mode (off, low, medium, high) and percentage.
- A change the device can't take (a mode it has no way to set) is not sent,
  and the other app is shown homeCore's state again within a second.
- **Reset** unpairs the bridge from every app and gives it a new code; what it
  shares stays chosen. Updates keep its pairing.

It runs in the plugin, on UDP port 5541 (the controller has 5540), and keeps
its pairing in `data/bridge/` and its choices in `data/bridge.json`. Its
pairing code is never written to the log.

The bridge's actions: `bridge_status`, `bridge_enable` (`on`),
`bridge_devices`, `bridge_share` (`device_id`, `shared`,
`confirm_security`) and `bridge_reset`.

## Backing up the pairings

Every pairing (the devices paired here, and the apps the bridge is paired
with) is kept in the plugin's data folder on the runtime, which homeCore's own
backup doesn't hold. Lose it and every device needs pairing again.

- **Download a backup** on the plugin's page (or the `backup` action, which
  streams it) makes one file, `hc-matter-backup-<date>.json.gz`: the
  controller's and the bridge's storage and the bridge's choices, without
  caches that are fetched again. Matter pauses for a few seconds while it is
  copied. Keep it off the house's server.
- **Restore from a backup** (`restore_backup`, sent the file as an upload;
  needs SDK 0.4.7 and homeCore 0.1.87 or later) checks the file, moves what is
  there now to `data/before-restore-<time>/` (never deleted by the plugin),
  writes the backup and restarts the plugin.
- A notice says so while the pairings have never been backed up, or some are
  newer than the last backup.

## Devices

Each Matter endpoint that has a device type becomes one homeCore device. Its id
comes from the device's own Matter unique id, not the number this controller
gave it, so a device paired again (after a reset, or a lost fabric) comes back
as the same homeCore device, with its name, room, history and automations:
`matter_<node uid>_<endpoint>`, or `matter_<node uid>_<bridged uid>` behind a
bridge (the uids hashed). A device that gives no unique id (optional before
Matter 1.2) is `matter_n<node>_<endpoint>`. Devices behind a Matter bridge (a Hue bridge, an
IKEA hub) each become their own device. A device's name is its bridged name, or
else the node's. When two endpoints share a name, what each one is gets added,
as in "Hall Climate temperature". Rename and place devices in homeCore.

| Matter device | homeCore type | Reports | Takes |
|---|---|---|---|
| On/off, dimmable, colour temperature and colour lights; dimmable plugs | `light` | `on`, `brightness_pct`, `color_temp` (K), `color_xy` | the same, `color_rgb`, `transition_ms`, action `toggle` |
| On/off plugs, mounted switches | `switch` | `on` | `on`, action `toggle` |
| Door lock | `lock` | `locked`, `jammed`, `open` (with a door sensor) | `locked` |
| Window covering | `cover` | `position` (100 = open), `tilt_pct` | the same, actions `open`, `close`, `stop` |
| Thermostat | `thermostat` | `temperature`, `heat_setpoint`, `cool_setpoint`, `hvac_mode`, `hvac_action`, `fan_mode` | setpoints, `hvac_mode`, `fan_mode` |
| Fan | `fan` | `on`, `speed_pct` | the same |
| Contact sensor | `contact_sensor` | `open` | |
| Occupancy sensor | `occupancy_sensor` | `occupied` | |
| Temperature, humidity, light, pressure sensors | `temperature_sensor`, `humidity_sensor`, `light_sensor`, `pressure_sensor` | `temperature` (°C), `humidity` (%), `illuminance` (lux), `pressure` (hPa) | |
| Water leak, rain | `water_sensor`, `rain_sensor` | `water_detected`, `rain_detected` | |
| Smoke and CO alarms | `smoke_alarm` | `smoke`, `co_detected` (true at a warning or an alarm; they raise homeCore's critical smoke and carbon monoxide alerts), `smoke_level`, `co_level`, and out of the way `hardware_fault`, `end_of_service`, `muted`, `test_in_progress` | action `self_test` |
| Air quality sensors | `air_quality_sensor` | `air_quality` (good … extremely_poor), `pm25_ugm3`, `pm10_ugm3`, `co2`, and temperature and humidity when it has them | |
| Buttons and remotes (Generic Switch): one device per remote, button 1, 2, … in order | `remote` | `button_N` (press, hold, release), and `pushed`, `held`, `released`, `double_tapped` holding the button's number for an instant, as automations' button triggers read; `last_button` | |
| Anything else | `matter` | what its clusters above report | |

On any device, where present:

- **Battery:** `battery_pct`, `battery_low`.
- **Power metering:** `power_w`, `energy_kwh`, `voltage`, `current_a`.
- **CO₂:** `co2` (ppm).
- **Identify:** the action `identify`, which makes the device blink or beep.
- **Diagnostics:** `vendor`, `product`, `firmware_version`, `serial_number`,
  `matter_device_type`, and `matter_unmapped_clusters` (Matter clusters it has
  that this plugin doesn't show yet), out of the way.

A device is offline when its node stops answering, or when the bridge it is
behind says it can't reach it. State is what the device reports; a command
that a device refuses changes nothing.

## Notices

- **The Matter server keeps stopping.** It has exited three times in a row,
  with the reason from its log.
- **Some devices are not answering.**
- **No devices are paired yet.**
- **Test devices are allowed** (`allow_test_devices` is on).

## Alerts

- **Firmware update available** (`firmware_update`, off until you turn it
  on): a newer firmware is published for a paired device. It is on the node's
  first homeCore device, names the node and the version, and its **Update…**
  button installs it after a confirm. The plugin asks ten minutes after it
  starts and then twice a day; the alert clears when the device runs that
  version. Needs `firmware_updates` on.

## Settings

On the plugin's settings form in the app (Controller, Network, Advanced), or
in its config file under `[matter]`. Saving restarts the plugin.

| Setting | Default | |
|---|---|---|
| `fabric_label` | `"homeCore"` | How this controller appears in other apps' lists of what a device is paired with |
| `log_level` | `"info"` | matter-server's own log level: `debug`, `info`, `warn`, `error`. Its info lines (every exchange with every device) reach the plugin's log at debug |
| `primary_interface` | | The network interface to use for IPv6 link-local addresses, when the host has several |
| `allow_test_devices` | `false` | Trust Matter's test certificates (development kits, stand-ins). A certified product never needs it |
| `dcl_offline` | `false` | Never ask the CSA's Distributed Compliance Ledger about certificates; use only those bundled and stored |
| `thread_diagnostics` | `true` | Find Thread border routers and read their diagnostics |
| `firmware_updates` | `true` | Check for device firmware updates |
| `storage_dir` | `data/matter-server` | Where the fabric is kept. Not on the form: moving it leaves every paired device behind |

## Developing

```sh
npm ci
npm run build     # TypeScript to out/, and the page to ui/dist
npm test          # the mapping, conversions, config, the page's logic; no network
```

The device mapping is pure (`src/devices.ts`). It is tested against a node dump
that matter-server produced for the stand-in (`tests/fixtures`), not a
hand-written one.

### The stand-in, and never the house

`standin/standin.mjs` is a virtual Matter bridge built with matter.js. It
carries one of each device type above, and each behaves as a real device would
at the protocol level. Its readings can be changed while it runs by writing
JSON lines to its stdin (`{"device": "contact", "open": true}`).

Run it, and anything that pairs with it, only on a network that cannot reach a
real one. mDNS from a sandbox would find real devices. The sandbox does this
with an internal Docker network:

```sh
docker network create --internal --ipv6 hc-matter-lab
docker run -d -i --name hc-mlab-standin --network hc-matter-lab \
  -v "$PWD":/app:ro -v <a homeCore Node interpreter>:/opt/node:ro -w /app \
  --entrypoint /opt/node/bin/node hc-runtime-node:dev standin/standin.mjs --storage /tmp/standin
```

A Node runtime on that network, with homeCore reached through a relay on its
loopback, can then install this plugin, pair the stand-in (code
`34970112332`), and drive every device. The stand-in uses Matter's test
certificates, so the sandbox sets `allow_test_devices = true`.

## Releasing

Set the version in `package.json` and tag `v<version>`. The release workflow
(`hc-scripts`' `node-release.yml`):

1. Builds the artifact from the lock, with no dev or optional dependencies and
   no install scripts. It refuses native code, so one file runs on x86_64 and
   aarch64.
2. Starts the artifact against a broker.
3. Lists it in the registry.

## License

MIT OR Apache-2.0. matter-server and matter.js are Apache-2.0.
