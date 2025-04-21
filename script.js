async function loadZonesFromGeoJSON(filepath) {

  const response = await fetch(filepath);
  const geojson = await response.json();
  const zonePolygons = {};

  geojson.features.forEach(feature => {
    const zoneName = feature.properties.name || feature.properties.Name || 'Unknown';
    const coords = feature.geometry.coordinates[0].map(coord => [coord[1], coord[0]]);
    zonePolygons[zoneName] = coords;
  });

  return zonePolygons;
}

document.addEventListener('DOMContentLoaded', async () => {
    // --- Configuration ---
    const TRIER_COORDS = [49.7567, 6.6414]; // Trier center
    const INITIAL_ZOOM = 14;
    let SEARCH_RADIUS_METERS = 200; // Changed to let to make it adjustable
    const OVERPASS_API_URL = 'https://overpass-api.de/api/interpreter';
    const NOMINATIM_API_URL = 'https://nominatim.openstreetmap.org/search';

    // --- Load Zone Polygons ---
    const zonePolygons = await loadZonesFromGeoJSON('./data/zonen.geojson');

    const zoneColors = { N: '#3792cb', M: '#97b566', S: '#e57373' };

    // --- Leaflet Setup ---
    const map = L.map('map').setView(TRIER_COORDS, INITIAL_ZOOM);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap contributors'
    }).addTo(map);

    // Zone‑Overlays
    const zoneLayer = L.layerGroup().addTo(map);
    for (let z of ['N','M','S']) {
        L.polygon(zonePolygons[z], {
            color: zoneColors[z],
            fillColor: zoneColors[z],
            fillOpacity: 0.2,
            weight: 2
        }).bindPopup(`Bewohnerzone ${z}`)
          .addTo(zoneLayer);
    }

    // Marker‑Layer
    const userLayer = L.layerGroup().addTo(map);
    const streetLayer = L.layerGroup().addTo(map);
    let routingControl = null;
    let userPos = null;
    let highlightedStreet = null; // Track currently highlighted street

    // Hilfsfunktion: Punkt in Polygon?
    function pointInPoly(pt, poly) {
        let x = pt[0], y = pt[1], inside = false;
        for (let i=0,j=poly.length-1; i<poly.length; j=i++) {
            let xi=poly[i][0], yi=poly[i][1],
                xj=poly[j][0], yj=poly[j][1],
                intersect = ((yi>y)!=(yj>y)) &&
                            (x < (xj-xi)*(y-yi)/(yj-yi) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }
    function getZone(lat,lon) {
        for (let z of ['N','M','S']) {
            if (pointInPoly([lat,lon], zonePolygons[z])) return z;
        }
        return null;
    }

    // Karte updaten
    function updateUserMarker(lat,lon) {
        userLayer.clearLayers();
        userPos = [lat,lon];
        L.marker(userPos,{icon:L.divIcon({className:'user-marker', html:'<div class="user-marker-icon"></div>'})})
         .addTo(userLayer).bindPopup('Ihr Standort').openPopup();
        L.circle(userPos,{radius:SEARCH_RADIUS_METERS, color:'#007bff', fillColor:'#007bff', fillOpacity:0.1})
         .addTo(userLayer);
        map.setView(userPos,16);
    }

    // Overpass‑Abfrage
    async function fetchStreets(lat,lon) {
        const q = `
[out:json][timeout:25];
way["highway"~"^(residential|living_street|unclassified|tertiary|secondary|primary)$"]
  (around:${SEARCH_RADIUS_METERS},${lat},${lon});
out body; >; out skel qt;`;
        let resp = await fetch(OVERPASS_API_URL + '?data=' + encodeURIComponent(q));
        let js = await resp.json();
        let nodes = {};
        js.elements.filter(e=>e.type==='node').forEach(n=>nodes[n.id]=[n.lat,n.lon]);
        return js.elements
            .filter(e=>e.type==='way' && e.tags?.name)
            .map(w=>{
                w.coords = w.nodes.map(id=>nodes[id]).filter(Boolean);
                return w;
            });
    }

    // Filter: nur Strecken, deren Mittelpunkt außerhalb aller Zonen liegt
    function isPublic(way) {
        if (!way.coords.length) return false;
        let mid = way.coords[Math.floor(way.coords.length/2)];
        return !getZone(mid[0], mid[1]);
    }

    // Hervorheben einer Straße
    function highlightStreet(way) {
        // Remove previous highlight if exists
        if (highlightedStreet) {
            streetLayer.removeLayer(highlightedStreet);
        }
        
        if (!way) return; // Exit if no way provided
        
        // Create new highlight
        highlightedStreet = L.polyline(way.coords, {
            color: '#FF6B00',
            weight: 6,
            opacity: 0.7
        }).addTo(streetLayer)
         .bindPopup(`<strong>${way.tags.name}</strong><br>
                     <div class="popup-buttons" style="display: flex; gap: 5px;">
                        <button class="popup-route-btn walking">🚶</button>
                       <button class="popup-route-btn transit">🚌</button></div>`)
         .on('popupopen', e => {
             let mid = way.coords[Math.floor(way.coords.length/2)];
             let c = e.popup.getElement();
             c.querySelector('.popup-route-btn.walking')
               .onclick = () => routeTo(mid, 'walking');
             c.querySelector('.popup-route-btn.transit')
               .onclick = () => routeTo(mid, 'transit');
         });
        
        // Ensure the full street is visible
        let bounds = L.latLngBounds(way.coords);
        map.fitBounds(bounds, { padding: [50, 50] });
    }

    // Routing: Fuß oder ÖPNV
    function routeTo(dest, mode) {
        if (routingControl) { 
            map.removeControl(routingControl); 
            routingControl = null; 
        }
        
        if (mode === 'transit') {
            let origin = userPos.join(','), dst = dest.join(',');
            window.open(`https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${dst}&travelmode=transit`);
            return;
        }
        
        // For walking mode, use the Leaflet Routing Machine
        try {
            // Check if L.Routing is available
            if (!L.Routing) {
                throw new Error('Leaflet Routing Machine is not loaded');
            }
            
            // Create a custom plan for our route
            const plan = new L.Routing.Plan([
                L.latLng(...userPos),
                L.latLng(...dest)
            ], {
                createMarker: function(i, waypoint) {
                    const icons = ['🏠', '🎯'];
                    return L.marker(waypoint.latLng, {
                        icon: L.divIcon({
                            html: `<div class="route-marker">${icons[i] || '📍'}</div>`,
                            className: 'route-marker-container',
                            iconSize: [25, 25]
                        })
                    });
                },
                draggableWaypoints: false,
                addWaypoints: false
            });
            
            // Use GraphHopper as an alternative - better pedestrian support
            const router = L.Routing.osrmv1({
                serviceUrl: 'https://router.project-osrm.org/route/v1', 
                profile: 'walking', // Should be 'walking' not 'foot'
                timeout: 10000,
                handleErrors: function(error) {
                    console.error('Routing error:', error);
                    alert('Fehler beim Laden der Route. Bitte versuchen Sie es später erneut.');
                    return error;
                },
                // Force pedestrian options
                routingOptions: {
                    alternatives: false,
                    steps: true
                }
            });
            
            // Log the request URL for debugging
            const originalOsrmRequest = router._makeRequest;
            router._makeRequest = function(url, callback) {
                console.log('Routing request URL:', url); 
                return originalOsrmRequest.call(this, url, callback);
            };
            
            routingControl = L.Routing.control({
                plan: plan,
                router: router,
                lineOptions: {
                    styles: [
                        {color: '#0066ff', opacity: 0.8, weight: 6},
                        {color: 'white', opacity: 0.5, weight: 4}
                    ],
                    missingRouteStyles: [
                        {color: '#dd3333', opacity: 0.8, weight: 6},
                        {color: 'black', opacity: 0.2, weight: 4, dashArray: '10,10'}
                    ],
                    extendToWaypoints: true,
                    addWaypoints: false
                },
                fitSelectedRoutes: true,
                showAlternatives: false,
                collapsible: true,
                show: true,
                routeWhileDragging: false,
                formatter: new L.Routing.Formatter({
                    language: 'de',
                    unitSystem: 'metric',
                    roundingSensitivity: 5
                }),
                waypoints: [
                    L.latLng(...userPos),
                    L.latLng(...dest)
                ]
            }).addTo(map);
            
            // Make sure the routing container is visible
            routingControl.on('routesfound', function(e) {
                console.log('Routes found:', e.routes);
                // Ensure container is shown
                if (routingControl._container) {
                    const itineraryContainer = routingControl._container.querySelector('.leaflet-routing-container');
                    if (itineraryContainer) {
                        itineraryContainer.classList.remove('leaflet-routing-container-hide');
                        itineraryContainer.style.display = 'block';
                        itineraryContainer.style.maxHeight = '50vh';
                        itineraryContainer.style.overflowY = 'auto';
                    }
                }
            });
            
            routingControl.on('routingerror', function(e) {
                console.error('Routing error:', e.error);
                alert('Fehler beim Berechnen der Route: ' + (e.error.message || 'Unbekannter Fehler'));
            });
            
            // Force directions to show initially
            setTimeout(() => {
                if (routingControl && routingControl._container) {
                    const itineraryContainer = routingControl._container.querySelector('.leaflet-routing-container');
                    if (itineraryContainer) {
                        itineraryContainer.classList.remove('leaflet-routing-container-hide');
                        itineraryContainer.style.display = 'block';
                        itineraryContainer.style.maxHeight = '50vh';
                        itineraryContainer.style.overflowY = 'auto';
                    }
                }
            }, 300);
        } catch (error) {
            console.error('Error setting up routing:', error);
            alert('Fehler beim Einrichten der Route: ' + error.message);
        }
    }

    // Anzeige der Ergebnisse
    function showResults(ways) {
        streetLayer.clearLayers();
        highlightedStreet = null;
        
        let ul = document.getElementById('parking-list');
        ul.innerHTML = '';
        let publicWays = ways.filter(isPublic);
        
        if (!publicWays.length) {
            ul.innerHTML = `<li class="note-item">Keine öffentlichen Parkstraßen in ${SEARCH_RADIUS_METERS} m gefunden.</li>`;
            return;
        }
        
        // Draw all streets with a subtle style
        publicWays.forEach(way => {
            L.polyline(way.coords, {
                color: '#999999',
                weight: 3,
                opacity: 0.4
            }).addTo(streetLayer);
        });
        
        publicWays.forEach((w, i) => {
            let mid = w.coords[Math.floor(w.coords.length/2)];
            let li = document.createElement('li');
            li.textContent = `${i+1}. ${w.tags.name}`;
            li.onclick = () => highlightStreet(w);
            
            // Buttons: Zu Fuß & ÖPNV
            let btns = document.createElement('span');
            btns.style.display = 'flex';
            btns.style.gap = '5px';
            btns.style.marginLeft = '5px';
            
            ['walking','transit'].forEach(m => {
                let b = document.createElement('button');
                b.className = `route-btn ${m}`;
                b.textContent = m==='walking'?'🚶':'🚌';
                b.title = m==='walking'?'Zu Fuß':'Öffentlicher Verkehr';
                b.onclick = e => {
                    e.stopPropagation();
                    routeTo(mid, m);
                };
                btns.appendChild(b);
            });
            li.appendChild(btns);
            ul.appendChild(li);
        });
        
        let note = document.createElement('li');
        note.className = 'note-item';
        note.innerHTML = '<strong>Wichtig:</strong> Bitte immer die örtliche Beschilderung beachten!';
        ul.appendChild(note);
    }

    // Komplettsuche
    async function doSearch(lat,lon) {
        updateUserMarker(lat,lon);
        document.getElementById('parking-list')
                .innerHTML = `<li>Suche...</li>`;
        let ways = await fetchStreets(lat,lon);
        showResults(ways);
    }

    // Events
    document.getElementById('locate-btn')
        .addEventListener('click', () => {
            if (!navigator.geolocation) return alert('Keine Geolocation');
            navigator.geolocation.getCurrentPosition(
                p=>doSearch(p.coords.latitude,p.coords.longitude),
                e=>alert('Fehler: '+e.message)
            );
        });
    document.getElementById('search-btn')
        .addEventListener('click', async ()=>{
            let name = document.getElementById('street-input').value.trim();
            if (!name) return alert('Bitte Straße eingeben');
            let resp = await fetch(`${NOMINATIM_API_URL}?q=${encodeURIComponent(name+', Trier')}&format=json&limit=1`);
            let js = await resp.json();
            if (!js.length) return alert('Straße nicht gefunden');
            doSearch(+js[0].lat, +js[0].lon);
        });
    document.getElementById('street-input')
        .addEventListener('keypress', e=>e.key==='Enter' && document.getElementById('search-btn').click());

    // Add radius control
    const radiusControl = document.createElement('div');
    radiusControl.className = 'radius-control';
    radiusControl.innerHTML = `
        <label>
            Suchradius: <span id="radius-value">${SEARCH_RADIUS_METERS}</span> m
            <input type="range" id="radius-slider" min="100" max="500" step="50" value="${SEARCH_RADIUS_METERS}">
        </label>
    `;
    document.querySelector('.controls').appendChild(radiusControl);

    document.getElementById('radius-slider').addEventListener('input', (e) => {
        SEARCH_RADIUS_METERS = parseInt(e.target.value);
        document.getElementById('radius-value').textContent = SEARCH_RADIUS_METERS;
        
        // If user position exists, update the circle radius
        if (userPos) {
            userLayer.clearLayers();
            L.marker(userPos, {icon: L.divIcon({className: 'user-marker', html: '<div class="user-marker-icon"></div>'})})
             .addTo(userLayer).bindPopup('Ihr Standort');
            L.circle(userPos, {radius: SEARCH_RADIUS_METERS, color: '#007bff', fillColor: '#007bff', fillOpacity: 0.1})
             .addTo(userLayer);
        }
    });

    // Zone‑Toggle
    let tog = document.createElement('label');
    tog.innerHTML = `<input type="checkbox" checked> Bewohnerzonen`;
    tog.querySelector('input').onchange = e=>{
        if (e.target.checked) map.addLayer(zoneLayer);
        else map.removeLayer(zoneLayer);
    };
    document.querySelector('.controls').appendChild(tog);

    // Erste Meldung
    document.getElementById('parking-list')
            .innerHTML = `<li>Geben Sie Ihren Standort oder eine Straße ein.</li>`;
});
