// Stand-in for the WebGL map: exposes what the real MapView is given, and lets the test "click" the way the map would.
import type { ReactNode } from "react";
export const probe: { props: any } = { props: null };
export default function FakeMapView(props: any) { probe.props = props; return <div data-testid="map">{props.children as ReactNode}</div>; }
export type Bbox = [number, number, number, number];
export type MapFeature = any;
export type MapImagery = any;
