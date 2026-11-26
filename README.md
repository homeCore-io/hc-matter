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

Use the plugin's **Pair a device** action with the device's setup code: the
text of its QR code (`MT:…`), or its 11- or 21-digit code.

Pairing is over the network only. That means:

- **A device already in another app:** in that app, choose to share it
  (Apple Home: *Turn On Pairing Mode*; Google Home: *Linked Matter apps &
  services*; Alexa: *Other assistants and apps*), and pair the new code it
  shows.
- **A Wi-Fi or Ethernet device that is already on the network:** pair its
  code.
- **A brand-new device that has to be set up over Bluetooth** can't be paired
  here yet. Set it up in its usual app first, then share it.

**Remove a device** (`remove_node`, with the node id) removes it from homeCore
and from this controller's fabric. Other apps it is shared with keep it.

## Devices

Each Matter endpoint that has a device type becomes one homeCore device, with
id `matter_<node>_<endpoint>`. Devices behind a Matter bridge (a Hue bridge, an
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

## Settings

In the plugin's config file, under `[matter]`:

| Setting | Default | |
|---|---|---|
| `fabric_label` | `"homeCore"` | How this controller appears in other apps' lists of what a device is paired with |
| `log_level` | `"info"` | matter-server's own log level: `debug`, `info`, `warn`, `error` |
| `primary_interface` | | The network interface to use for IPv6 link-local addresses, when the host has several |
| `allow_test_devices` | `false` | Trust Matter's test certificates (development kits, stand-ins). A certified product never needs it |
| `dcl_offline` | `false` | Never ask the CSA's Distributed Compliance Ledger about certificates; use only those bundled and stored |
| `thread_diagnostics` | `true` | Find Thread border routers and read their diagnostics |
| `firmware_updates` | `true` | Check for device firmware updates |
| `storage_dir` | `data/matter-server` | Where the fabric is kept |

## Developing

```sh
npm ci
npm test          # the mapping, conversions, config; no network
npm run build     # TypeScript to out/
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
