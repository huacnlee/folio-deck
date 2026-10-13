# OceanView — fleet tracking example by gpui-shell

A native fleet-tracking dashboard built with [gpui-shell](https://gpui-kit.com/shell/), recreating the OceanView concept by [@IamMuhammadMuiz](https://x.com/IamMuhammadMuiz/status/2109684343941554293). Five container ships sail real sea lanes on a live Mercator map; their position, ETA, fuel and alerts are calculated, not drawn from fixed numbers.

<img width="1461" height="940" alt="image" src="https://github.com/user-attachments/assets/89f3da22-4ce3-4123-a5d3-af5d52b46277" />

## Reference

- Recreated from the **OceanView** fleet-tracking concept by [@IamMuhammadMuiz](https://x.com/IamMuhammadMuiz/status/2109684343941554293) — its layout (sidebar, live map with vessel cards, Route & Position, Speed & Course, Fuel & Consumption and Recent Alerts) and the screenshot it was briefed from.
- The design and product ideas belong to the original author. The code is MIT; the design may not be used commercially — see the [licence terms](../../README.md#license).

## Run

```bash
gpui-shell types -d apps/ocean-view
gpui-shell run -d apps/ocean-view --watch
```

Tests for the navigation maths and simulation run under Node.js:

```bash
node --test apps/ocean-view/tests/*.test.mjs
gpui-shell check -d apps/ocean-view
```

## What it does

| Area | Behaviour |
| --- | --- |
| Live map | Web Mercator view of the coastlines, ports, each vessel's planned track (dashed) and the track sailed in the last 6 / 24 / 72 hours (solid). Ships are drawn pointing along their heading. **Drag** to pan (the map leaves Live Map for a free view, and the release never selects the ship under it); **scroll** to zoom about the pointer, from the whole world down to about 12 NM across; **+ / −** zoom about the centre; the **arrow** recentres on the selected ship. The **Live Map** menu follows the selected ship, fits the whole fleet or shows the world; the **Last 24 hours** menu sets the track and fuel-chart window; the **expand** button hides the cards. |
| Vessels | Click a ship in the sidebar, its glyph or its label on the map to select it; the info card, compass, coordinates and the four cards follow. Search filters vessels by name, IMO, MMSI or port. |
| Route & Position | Origin, destination, ETA, remaining distance and progress along the planned route. |
| Speed & Course | Speed dial, course over ground and heading (which leans off course while the autopilot corrects cross-track error). |
| Fuel & Consumption | Fuel remaining over the selected window, fuel level and current burn in tonnes per day. |
| Alerts | Rules raise alerts automatically; clicking one marks it read and opens its vessel on the map. The sidebar badge and the bell's dot count unread alerts. The Alerts page (also the bell) has Mark read / Mark unread per alert, Mark all read and Clear read. |
| New Route | Pick a vessel, a departure port and a destination; the shortest sea route is planned and shown with distance, duration and fuel before you assign it. |
| Create Report | Writes a Markdown fleet snapshot to `reports/` in the app's data folder and copies it to the clipboard. The Reports page lists the reports and previews the one you pick. |
| Fleet / Settings | A table of every vessel (click a row to open it on the map); the simulation speed (real time, ×60, ×600, ×3600 — also cycled from **System Online** in the top bar) and **Reset simulation**. The avatar menu links to Settings, Reports and Alerts and copies a fleet report. **Contact Support** copies the support address. |

The layout adapts to the window: below about 1450 × 900 the cards stack their figures, and the sidebar scrolls when it is taller than the window.

**Known gap:** trackpad pinch-to-zoom is not available — gpui-shell 0.7.3 exposes scroll-wheel events but not GPUI's pinch gesture, so zooming is by scroll, + / − or the menu.

State is saved to `localStorage`. While the app is closed the voyages continue in real time (up to 30 days of catch-up on the next start).

## What is real and what is simulated

**Calculated:** great-circle distance, bearing and interpolation on a spherical Earth; routes are Dijkstra shortest paths over a graph of real ports and sea-lane waypoints (Malacca, Suez, Gibraltar, Panama, Cape of Good Hope…), with real port coordinates; position, course, remaining distance, ETA and progress follow from distance sailed; fuel burn follows the propeller law (burn ∝ speed³); alert rules — cross-track error above 4 NM, fuel below 20 % (the vessel slows to 80 % of cruise speed), engine above 95 °C, arrival and running out of fuel — are evaluated every step with hysteresis so each fires once.

**Simulated data source:** there is no AIS feed. The five vessels, their IMO/MMSI numbers, tank capacity and design burn are sample data; speed, cross-track drift and engine temperature are random walks; the coastlines are hand-traced low-resolution outlines, so the map is for orientation, not navigation. The vessel photo is an illustration.

## Files

- `main.js` — the view: sidebar, top bar, map overlays, cards, pages and the New Route dialog
- `map.js` — the Mercator map drawn with `PathBuilder` / `window.paint_path`
- `sim.js` — fleet state, simulation step, alert rules, route assignment and the report
- `geo.js`, `ports.js`, `world.js` — navigation maths, the port and sea-lane graph, coastlines
- `theme.js`, `ui.js` — palette and small UI helpers; `ocean-view/icons/` — SVG icons
