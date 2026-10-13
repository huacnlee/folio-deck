// Ports with their real coordinates, and the sea lanes that join them.
// Routes are the shortest path through this lane graph, so a voyage goes
// round continents through the real straits and canals instead of overland.

import { distance } from "./geo.js";

/** @typedef {{ id: string, name: string, lat: number, lon: number, port?: boolean }} Node */

/** @type {Record<string, Node>} */
export const nodes = {
  singapore: { id: "singapore", name: "Singapore", lat: 1.264, lon: 103.84, port: true },
  portklang: { id: "portklang", name: "Port Klang", lat: 2.999, lon: 101.393, port: true },
  hongkong: { id: "hongkong", name: "Hong Kong", lat: 22.287, lon: 114.165, port: true },
  shanghai: { id: "shanghai", name: "Shanghai", lat: 31.233, lon: 121.49, port: true },
  busan: { id: "busan", name: "Busan", lat: 35.103, lon: 129.04, port: true },
  tokyo: { id: "tokyo", name: "Tokyo", lat: 35.617, lon: 139.783, port: true },
  losangeles: { id: "losangeles", name: "Los Angeles", lat: 33.74, lon: -118.265, port: true },
  balboa: { id: "balboa", name: "Balboa (Panama)", lat: 8.95, lon: -79.565, port: true },
  newyork: { id: "newyork", name: "New York", lat: 40.668, lon: -74.045, port: true },
  rotterdam: { id: "rotterdam", name: "Rotterdam", lat: 51.95, lon: 4.142, port: true },
  hamburg: { id: "hamburg", name: "Hamburg", lat: 53.546, lon: 9.966, port: true },
  colombo: { id: "colombo", name: "Colombo", lat: 6.94, lon: 79.843, port: true },
  jebelali: { id: "jebelali", name: "Jebel Ali (Dubai)", lat: 25.011, lon: 55.061, port: true },
  mombasa: { id: "mombasa", name: "Mombasa", lat: -4.063, lon: 39.666, port: true },
  sydney: { id: "sydney", name: "Sydney", lat: -33.861, lon: 151.21, port: true },
  santos: { id: "santos", name: "Santos", lat: -23.987, lon: -46.3, port: true },

  malacca: { id: "malacca", name: "Malacca Strait", lat: 5.9, lon: 97.0 },
  dondra: { id: "dondra", name: "Dondra Head", lat: 5.6, lon: 80.6 },
  socotra: { id: "socotra", name: "Gulf of Aden", lat: 12.4, lon: 50.0 },
  babelmandeb: { id: "babelmandeb", name: "Bab-el-Mandeb", lat: 12.6, lon: 43.4 },
  redsea: { id: "redsea", name: "Red Sea", lat: 20.0, lon: 38.8 },
  suez: { id: "suez", name: "Suez Canal", lat: 29.9, lon: 32.55 },
  portsaid: { id: "portsaid", name: "Port Said", lat: 31.4, lon: 32.35 },
  crete: { id: "crete", name: "South of Crete", lat: 34.3, lon: 24.5 },
  sicily: { id: "sicily", name: "Strait of Sicily", lat: 37.3, lon: 11.6 },
  gibraltar: { id: "gibraltar", name: "Gibraltar", lat: 35.95, lon: -5.6 },
  finisterre: { id: "finisterre", name: "Cape Finisterre", lat: 43.3, lon: -10.0 },
  ushant: { id: "ushant", name: "Ushant", lat: 48.6, lon: -5.6 },
  dover: { id: "dover", name: "Dover Strait", lat: 51.0, lon: 1.5 },
  helgoland: { id: "helgoland", name: "German Bight", lat: 54.1, lon: 7.8 },
  hormuz: { id: "hormuz", name: "Strait of Hormuz", lat: 26.4, lon: 56.6 },
  oman: { id: "oman", name: "Arabian Sea", lat: 22.0, lon: 61.0 },
  guardafui: { id: "guardafui", name: "Cape Guardafui", lat: 11.9, lon: 52.2 },
  mozambique: { id: "mozambique", name: "Mozambique Channel", lat: -16.0, lon: 42.0 },
  goodhope: { id: "goodhope", name: "Cape of Good Hope", lat: -35.2, lon: 19.5 },
  namibia: { id: "namibia", name: "South Atlantic", lat: -20.0, lon: 7.0 },
  guinea: { id: "guinea", name: "Gulf of Guinea", lat: 1.0, lon: -5.0 },
  dakar: { id: "dakar", name: "Cape Verde", lat: 14.5, lon: -19.5 },
  canary: { id: "canary", name: "Canary Islands", lat: 28.5, lon: -16.5 },
  recife: { id: "recife", name: "Off Recife", lat: -8.0, lon: -33.5 },
  scs: { id: "scs", name: "South China Sea", lat: 12.0, lon: 111.5 },
  taiwan: { id: "taiwan", name: "Taiwan Strait", lat: 24.3, lon: 119.4 },
  goto: { id: "goto", name: "Goto Islands", lat: 32.4, lon: 128.4 },
  osumi: { id: "osumi", name: "Osumi Strait", lat: 30.7, lon: 131.0 },
  northpacific: { id: "northpacific", name: "North Pacific", lat: 42.0, lon: -170.0 },
  mexico: { id: "mexico", name: "Off Mexico", lat: 15.0, lon: -100.0 },
  colon: { id: "colon", name: "Colón (Panama)", lat: 9.45, lon: -79.95 },
  yucatan: { id: "yucatan", name: "Yucatán Channel", lat: 21.6, lon: -85.8 },
  florida: { id: "florida", name: "Florida Strait", lat: 24.3, lon: -81.0 },
  hatteras: { id: "hatteras", name: "Cape Hatteras", lat: 35.0, lon: -74.5 },
  atlantic: { id: "atlantic", name: "North Atlantic", lat: 46.0, lon: -35.0 },
  javasea: { id: "javasea", name: "Java Sea", lat: -5.0, lon: 110.0 },
  lombok: { id: "lombok", name: "Lombok Strait", lat: -8.9, lon: 115.75 },
  timor: { id: "timor", name: "Timor Sea", lat: -11.5, lon: 124.0 },
  torres: { id: "torres", name: "Torres Strait", lat: -10.3, lon: 142.0 },
  coralsea: { id: "coralsea", name: "Coral Sea", lat: -16.0, lon: 152.0 },
};

/** Undirected sea lanes between nodes. */
const lanes = [
  ["singapore", "portklang"], ["portklang", "malacca"], ["malacca", "dondra"], ["dondra", "colombo"],
  ["dondra", "socotra"], ["colombo", "socotra"], ["socotra", "babelmandeb"], ["socotra", "guardafui"],
  ["babelmandeb", "redsea"], ["redsea", "suez"], ["suez", "portsaid"], ["portsaid", "crete"],
  ["crete", "sicily"], ["sicily", "gibraltar"], ["gibraltar", "finisterre"], ["finisterre", "ushant"],
  ["ushant", "dover"], ["dover", "rotterdam"], ["rotterdam", "helgoland"], ["helgoland", "hamburg"],
  ["dondra", "oman"], ["oman", "hormuz"], ["hormuz", "jebelali"], ["oman", "socotra"],
  ["guardafui", "mombasa"], ["mombasa", "mozambique"], ["mozambique", "goodhope"],
  ["goodhope", "namibia"], ["namibia", "guinea"], ["guinea", "dakar"], ["dakar", "canary"],
  ["canary", "gibraltar"], ["canary", "finisterre"], ["goodhope", "santos"], ["santos", "recife"],
  ["recife", "dakar"], ["recife", "florida"],
  ["singapore", "scs"], ["scs", "hongkong"], ["hongkong", "taiwan"], ["taiwan", "shanghai"],
  ["shanghai", "goto"], ["goto", "busan"], ["goto", "osumi"], ["osumi", "tokyo"],
  ["tokyo", "northpacific"], ["northpacific", "losangeles"], ["losangeles", "mexico"],
  ["mexico", "balboa"], ["balboa", "colon"], ["colon", "yucatan"], ["yucatan", "florida"],
  ["florida", "hatteras"], ["hatteras", "newyork"], ["newyork", "atlantic"], ["atlantic", "ushant"],
  ["colon", "recife"], ["singapore", "javasea"], ["javasea", "lombok"], ["lombok", "timor"],
  ["timor", "torres"], ["torres", "coralsea"], ["coralsea", "sydney"],
];

/** @type {Record<string, { to: string, nm: number }[]>} */
const graph = {};
for (const [a, b] of lanes) {
  const nm = distance(nodes[a], nodes[b]);
  (graph[a] ??= []).push({ to: b, nm });
  (graph[b] ??= []).push({ to: a, nm });
}

export const ports = Object.values(nodes).filter((n) => n.port);

/**
 * The shortest sea route between two ports (Dijkstra over the lane graph),
 * as the list of node ids it passes. `null` when they are not connected.
 */
export function plan(from, to) {
  if (from === to || !graph[from] || !graph[to]) return null;
  const best = { [from]: 0 };
  const previous = {};
  const open = new Set([from]);
  while (open.size) {
    let current = null;
    for (const id of open) if (current === null || best[id] < best[current]) current = id;
    open.delete(current);
    if (current === to) break;
    for (const { to: next, nm } of graph[current]) {
      const cost = best[current] + nm;
      if (cost < (best[next] ?? Infinity)) {
        best[next] = cost;
        previous[next] = current;
        open.add(next);
      }
    }
  }
  if (best[to] === undefined) return null;
  const path = [to];
  while (path[0] !== from) path.unshift(previous[path[0]]);
  return path;
}
