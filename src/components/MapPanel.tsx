import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useTheme } from "next-themes";
import { KIWI_SERVERS, type KiwiServer } from "@/lib/constants";

interface MapPanelProps {
  selectedServer: KiwiServer | null;
  onSelectServer: (server: KiwiServer) => void;
}

const LIGHT_TILES = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const DARK_TILES = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";

const LIGHT_STYLE: L.CircleMarkerOptions = {
  radius: 9,
  color: "#94a3b8",
  fillColor: "#94a3b8",
  fillOpacity: 0.5,
  weight: 2,
};

const DARK_STYLE: L.CircleMarkerOptions = {
  radius: 9,
  color: "#cbd5e1",
  fillColor: "#cbd5e1",
  fillOpacity: 0.6,
  weight: 2,
};

const PIN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="40" viewBox="0 0 28 40">
  <defs>
    <filter id="shadow" x="-20%" y="-10%" width="140%" height="130%">
      <feDropShadow dx="0" dy="2" stdDeviation="2" flood-opacity="0.35"/>
    </filter>
  </defs>
  <path d="M14 0C6.268 0 0 6.268 0 14c0 10.5 14 26 14 26s14-15.5 14-26C28 6.268 21.732 0 14 0z" fill="#22c55e" filter="url(#shadow)"/>
  <circle cx="14" cy="14" r="5.5" fill="white"/>
</svg>`;

const pinIcon = L.divIcon({
  html: PIN_SVG,
  className: "",
  iconSize: [28, 40],
  iconAnchor: [14, 40],
  popupAnchor: [0, -40],
});

export default function MapPanel({ selectedServer, onSelectServer }: MapPanelProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const circleMarkersRef = useRef<Map<string, L.CircleMarker>>(new Map());
  const pinMarkerRef = useRef<L.Marker | null>(null);
  const { resolvedTheme } = useTheme();

  const isDark = resolvedTheme === "dark";
  const markerStyle = isDark ? DARK_STYLE : LIGHT_STYLE;

  // Init map + markers
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = L.map(mapContainerRef.current, {
      center: [30, 8],
      zoom: 1,
      zoomControl: true,
    });

    const tileLayer = L.tileLayer(isDark ? DARK_TILES : LIGHT_TILES, {
      attribution: '&copy; <a href="https://openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
      maxZoom: 18,
    }).addTo(map);
    tileLayerRef.current = tileLayer;

    for (const server of KIWI_SERVERS) {
      const marker = L.circleMarker([server.lat, server.lng], markerStyle).addTo(map);
      marker.bindPopup(
        `<a href="http://${server.host}:${server.port}" target="_blank" rel="noopener noreferrer">${server.name}</a>`,
        { offset: [0, -8], closeButton: true },
      );
      marker.on("mouseover", () => marker.openPopup());
      marker.on("click", () => onSelectServer(server));
      circleMarkersRef.current.set(server.id, marker);
    }

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      tileLayerRef.current = null;
      circleMarkersRef.current.clear();
      pinMarkerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Invalidate map size when container resizes (e.g. tab switch on mobile)
  useEffect(() => {
    const map = mapRef.current;
    const container = mapContainerRef.current;
    if (!map || !container) return;
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  // Swap tiles + marker colors on theme change
  useEffect(() => {
    if (!tileLayerRef.current) return;
    tileLayerRef.current.setUrl(isDark ? DARK_TILES : LIGHT_TILES);
    circleMarkersRef.current.forEach((marker) => {
      marker.setStyle(markerStyle);
    });
  }, [isDark, markerStyle]);

  // Update markers on selection change
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // Remove previous pin
    if (pinMarkerRef.current) {
      pinMarkerRef.current.remove();
      pinMarkerRef.current = null;
    }

    // Reset all circle markers to visible default
    circleMarkersRef.current.forEach((marker) => {
      marker.setStyle(markerStyle);
      marker.setRadius(markerStyle.radius!);
      marker.setStyle({ opacity: 1, fillOpacity: markerStyle.fillOpacity! });
    });

    if (selectedServer) {
      // Hide the selected server's circle marker
      const circleMarker = circleMarkersRef.current.get(selectedServer.id);
      if (circleMarker) {
        circleMarker.setStyle({ opacity: 0, fillOpacity: 0 });
      }

      // Place pin marker
      const pin = L.marker([selectedServer.lat, selectedServer.lng], { icon: pinIcon }).addTo(map);
      pin.bindPopup(
        `<a href="http://${selectedServer.host}:${selectedServer.port}" target="_blank" rel="noopener noreferrer">${selectedServer.name}</a>`,
        { closeButton: true },
      );
      pin.on("click", () => onSelectServer(selectedServer));
      pin.setZIndexOffset(1000);
      pinMarkerRef.current = pin;
    }
  }, [selectedServer, onSelectServer]);

  return (
    <div className="h-full w-full relative rounded-lg overflow-hidden border border-border z-0">
      <div ref={mapContainerRef} className="h-full w-full" />
    </div>
  );
}