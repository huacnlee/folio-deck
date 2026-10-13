// The live map: a Web Mercator view of the coastlines, sea lanes, voyage
// tracks and vessels, drawn with native paths. Map coordinates are emitted
// as percentages of the map so the drawing fills whatever size it is given.

import { div, PathBuilder, Background } from "gpui-kit";
import { h_flex, v_flex, Button } from "gpui-base";
import { palette } from "./theme.js";
import { land } from "./world.js";
import { ports } from "./ports.js";
import { densify, along } from "./geo.js";
import { navigation, status } from "./sim.js";
import { icon, tones } from "./ui.js";

/** The widest and narrowest view, in degrees of longitude: the world, and a few tens of miles. */
export const MAX_SPAN = 360;
export const MIN_SPAN = 0.2;

export const mercY = (lat) => {
  const phi = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
  return (Math.log(Math.tan(Math.PI / 4 + phi / 2)) * 180) / Math.PI;
};

/** Latitude for a Mercator ordinate. */
export const mercLat = (y) => (Math.atan(Math.sinh((y * Math.PI) / 180)) * 180) / Math.PI;
export const MERC_LIMIT = mercY(85);

/** The longitude nearest `ref` among `lon`, `lon ± 360`. */
const near = (lon, ref) => lon + 360 * Math.round((ref - lon) / 360);

/**
 * The visible window: its centre in Mercator degrees (`cx` longitude, `cy`
 * ordinate) and its spans, `sy` following the map's aspect ratio.
 * @typedef {{ cx: number, cy: number, sx: number, sy: number }} View
 */

/** Map percentage for a point, choosing the world copy nearest the centre. */
function project(view, lat, lon) {
  const x = ((near(lon, view.cx) - view.cx) / view.sx) * 100 + 50;
  const y = ((view.cy - mercY(lat)) / view.sy) * 100 + 50;
  return [x, y];
}

const pct = (n) => /** @type {`${number}%`} */ (`${n.toFixed(3)}%`);

/** A polyline in map percentages, unwrapped so it never jumps across the date line. */
function polyline(view, points) {
  let ref = view.cx;
  return points.map((p) => {
    const lon = near(p.lon, ref);
    ref = lon;
    return [((lon - view.cx) / view.sx) * 100 + 50, ((view.cy - mercY(p.lat)) / view.sy) * 100 + 50];
  });
}

/** Extent of the fleet, as a centre and a longitude span that fits it. */
export function fitFleet(fleet, aspect) {
  const ref = navigation(fleet.vessels[0], fleet.time).lon;
  const pts = fleet.vessels.map((v) => {
    const n = navigation(v, fleet.time);
    return { lon: near(n.lon, ref), y: mercY(n.lat) };
  });
  const [x0, x1] = [Math.min(...pts.map((p) => p.lon)), Math.max(...pts.map((p) => p.lon))];
  const [y0, y1] = [Math.min(...pts.map((p) => p.y)), Math.max(...pts.map((p) => p.y))];
  const span = Math.min(MAX_SPAN, Math.max((x1 - x0) * 1.25, ((y1 - y0) * 1.35) / aspect, 20));
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, span };
}

function paint(builder, points, closed) {
  return builder.add_polygon(points.map(([x, y]) => [pct(x), pct(y)]), closed).build();
}

/** Coastlines, filled and edged with surf, in each world copy that is in view. */
function coastlines(view) {
  const layers = [];
  for (const ring of land) {
    const lons = ring.map((p) => p[0]);
    const [lo, hi] = [Math.min(...lons), Math.max(...lons)];
    for (const shift of [-360, 0, 360]) {
      const left = ((lo + shift - view.cx) / view.sx) * 100 + 50;
      const right = ((hi + shift - view.cx) / view.sx) * 100 + 50;
      if (right < -5 || left > 105) continue;
      const points = ring.map(([lon, lat]) => [((lon + shift - view.cx) / view.sx) * 100 + 50, ((view.cy - mercY(lat)) / view.sy) * 100 + 50]);
      const ys = points.map((p) => p[1]);
      if (Math.max(...ys) < -5 || Math.min(...ys) > 105) continue;
      layers.push(window.paint_path(paint(PathBuilder.fill(), points, true), palette.land).absolute().inset_0());
      layers.push(window.paint_path(paint(PathBuilder.stroke(5), points, true), "#6f9be03a").absolute().inset_0());
      layers.push(window.paint_path(paint(PathBuilder.stroke(1), points, true), palette.landEdge).absolute().inset_0());
    }
  }
  return layers;
}

/** Faint lines of latitude and longitude, every `step` degrees. */
function graticule(view) {
  const step = [30, 10, 5, 2, 1, 0.5, 0.25, 0.1, 0.05].find((s) => view.sx / s >= 4) ?? 0.05;
  const layers = [];
  const lon0 = Math.floor((view.cx - view.sx / 2) / step) * step;
  for (let lon = lon0; lon <= view.cx + view.sx / 2; lon += step) {
    const x = ((lon - view.cx) / view.sx) * 100 + 50;
    layers.push(paint(PathBuilder.stroke(1), [[x, 0], [x, 100]], false));
  }
  const lat0 = Math.max(-85, Math.floor(mercLat(view.cy - view.sy / 2) / step) * step);
  const lat1 = Math.min(85, mercLat(view.cy + view.sy / 2));
  for (let lat = lat0; lat <= lat1; lat += step) {
    const y = ((view.cy - mercY(lat)) / view.sy) * 100 + 50;
    if (y < 0 || y > 100) continue;
    layers.push(paint(PathBuilder.stroke(1), [[0, y], [100, y]], false));
  }
  return layers.map((p) => window.paint_path(p, "#5b8cff10").absolute().inset_0());
}

/** A vessel drawn from above, pointing along its heading, `size` pixels long. */
function vesselGlyph(heading, size, selected) {
  const box = size * 1.6;
  const c = box / 2;
  const a = ((heading - 90) * Math.PI) / 180;
  const [cos, sin] = [Math.cos(a), Math.sin(a)];
  const at = (x, y) => [c + x * cos - y * sin, c + x * sin + y * cos];
  const L = size / 2;
  const W = size * 0.17;
  const hull = [at(L, 0), at(L * 0.62, -W), at(-L, -W * 0.92), at(-L, W * 0.92), at(L * 0.62, W)];
  const shape = (pts) => PathBuilder.fill().add_polygon(pts, true).build();
  const rect = (x0, x1, y0, y1) => shape([at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1)]);
  const colors = ["#c2453c", "#2f6db5", "#d58a2e", "#3a8f6a", "#7a5aa8"];
  const blocks = [];
  const n = 5;
  for (let i = 0; i < n; i++) {
    const x0 = -L * 0.78 + (i * L * 1.2) / n;
    const x1 = x0 + (L * 1.2) / n - 1;
    blocks.push(window.paint_path(rect(x0, x1, -W * 0.7, -0.5), colors[i % 5]).absolute().inset_0());
    blocks.push(window.paint_path(rect(x0, x1, 0.5, W * 0.7), colors[(i + 2) % 5]).absolute().inset_0());
  }
  const wake = PathBuilder.stroke(2).add_polygon([at(-L, 0), at(-L * 2.2, -W * 0.6)], false).build();
  const wake2 = PathBuilder.stroke(2).add_polygon([at(-L, 0), at(-L * 2.2, W * 0.6)], false).build();
  return div()
    .relative()
    .size(box)
    .child(window.paint_path(wake, "#9fc0ff40").absolute().inset_0())
    .child(window.paint_path(wake2, "#9fc0ff40").absolute().inset_0())
    .child(window.paint_path(shape(hull), selected ? "#e6ebf3" : "#c9d0dc").absolute().inset_0())
    .children(blocks)
    .child(window.paint_path(rect(L * 0.3, L * 0.5, -W * 0.75, W * 0.75), "#f4f6fa").absolute().inset_0());
}

/** The dashed ring around the selected vessel. */
function ring(diameter) {
  const r = diameter / 2 - 1;
  const path = PathBuilder.stroke(1.2)
    .dash_array([4, 4])
    .move_to(diameter / 2 + r, diameter / 2)
    .arc_to(r, r * 0.72, 0, true, true, diameter / 2 - r, diameter / 2)
    .arc_to(r, r * 0.72, 0, true, true, diameter / 2 + r, diameter / 2)
    .build();
  return window.paint_path(path, palette.route).absolute().inset_0();
}

/**
 * @param {import("./sim.js").Fleet} fleet
 * @param {{ view: View, selected: string, trailHours: number, onSelect: (id: string, cx: any) => void }} options
 */
export function liveMap(fleet, options, cx) {
  const view = options.view;
  const sea = PathBuilder.fill().add_polygon([["0%", "0%"], ["100%", "0%"], ["100%", "100%"], ["0%", "100%"]], true).build();
  const layers = [
    window.paint_path(sea, Background.linear_gradient(180, Background.stop(palette.sea.top, 0), Background.stop(palette.sea.bottom, 100))).absolute().inset_0(),
    ...graticule(view),
    ...coastlines(view),
  ];

  for (const v of fleet.vessels) {
    const nav = navigation(v, fleet.time);
    const selected = v.id === options.selected;
    // Planned track ahead, dashed; the last hours sailed, solid.
    const ahead = [{ lat: nav.lat, lon: nav.lon }, ...densify(nav.points.slice(along(nav.points, nav.travelled).leg + 1))];
    const behindFrom = Math.max(0, nav.travelled - options.trailHours * v.cruise);
    const behind = [];
    for (let k = 0; k <= 12; k++) behind.push(along(nav.points, behindFrom + ((nav.travelled - behindFrom) * k) / 12));
    const dashed = PathBuilder.stroke(selected ? 1.6 : 1).dash_array([6, 5]);
    layers.push(window.paint_path(paint(dashed, polyline(view, ahead), false), selected ? palette.route : "#4f86ff55").absolute().inset_0());
    layers.push(window.paint_path(paint(PathBuilder.stroke(selected ? 2 : 1.2), polyline(view, behind), false), selected ? "#7aa7ff" : "#7aa7ff55").absolute().inset_0());
  }

  const portMarks = view.sx <= 90
    ? ports.map((p) => {
      const [x, y] = project(view, p.lat, p.lon);
      if (x < -2 || x > 102 || y < -2 || y > 102) return null;
      return h_flex()
        .absolute()
        .left(pct(x))
        .top(pct(y))
        .ml(-4)
        .mt(-4)
        .items_center()
        .gap(6)
        .child(div().size(8).rounded_full().border(2).border_color("#7fa6e8").bg("#061a40"))
        .child(div().text_size(10).text_color("#9fb6dc").whitespace_nowrap().child(p.name));
    }).filter(Boolean)
    : [];

  // Unselected vessels first, so the selected one is drawn, and hit, on top.
  const order = [...fleet.vessels].sort((a, b) => Number(a.id === options.selected) - Number(b.id === options.selected));
  const markers = order.flatMap((v) => {
    const nav = navigation(v, fleet.time);
    const [x, y] = project(view, nav.lat, nav.lon);
    if (x < -10 || x > 110 || y < -10 || y > 110) return [];
    const selected = v.id === options.selected;
    const size = selected ? 64 : 40;
    const box = size * 1.6;
    const st = status(v);
    const label = Button.new(`vessel-label-${v.id}`)
      .absolute()
      .left(-18)
      .top(-box / 2 + box * 0.18 - 50)
      .flex()
      .items_center()
      .gap(9)
      .px(11)
      .py(7)
      .rounded(8)
      .bg(palette.label)
      .border(1)
      .border_color(selected ? "#3d6fd6" : palette.labelBorder)
      .hover((el) => el.border_color("#5b8cff"))
      .on_click((_e, cx) => options.onSelect(v.id, cx))
      .child(selected ? icon("pin", 18).text_color(palette.blue) : div().size(10).rounded_full().border(2).border_color(tones[st.tone].dot).bg("#0c1a33"))
      .child(
        v_flex()
          .child(div().text_size(12).font_medium().whitespace_nowrap().child(v.name))
          .child(div().text_size(11).text_color("#b6c3dc").whitespace_nowrap().child(`${v.speed.toFixed(1)} kn · ${Math.round(nav.course)}°`)),
      );
    const glyph = Button.new(`vessel-${v.id}`)
      .absolute()
      .left(-box / 2)
      .top(-box / 2)
      .size(box)
      .on_click((_e, cx) => options.onSelect(v.id, cx))
      .when(selected, (el) => el.child(div().absolute().left(box * 0.05).top(box * 0.18).size(box * 0.9).child(ring(box * 0.9))))
      .child(div().absolute().inset_0().child(vesselGlyph(nav.heading, size, selected)));
    // A zero-sized anchor at the vessel's position; the glyph and label hang off it.
    return [div().absolute().left(pct(x)).top(pct(y)).size(0).child(glyph).child(label)];
  });

  return div().absolute().inset_0().overflow_hidden().children(layers).children(portMarks).children(markers);
}
