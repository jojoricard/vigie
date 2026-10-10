/* Translations and formatting.
   Every text shown on screen lives here. A value is a string, or a function when
   it takes figures. A missing key shows up as the key itself, never as silent
   English. */
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
export const I18N = {
  en: {
    "tab.overview": "Overview", "tab.weather": "Weather", "tab.machine": "Machine", "tab.tools": "Tools", "tab.house": "House",
    "loading": "Loading…", "searching": "Searching…", "unavailable": "Unavailable",
    "config.error": "Cannot read the configuration from the agent. Is agent.js running?",

    "wx.feels": "Feels like", "wx.humidity": "Humidity", "wx.wind": "Wind", "wx.uv": "UV",
    "wx.max": "max", "wx.min": "min", "wx.gustsLabel": "Gusts", "wx.rainToday": "Rain today", "wx.none": "none", "wx.uvMax": "UV max",
    "wx.unavailable": "Weather unavailable",
    "sun.rise": "Sunrise", "sun.set": "Sunset", "sun.daylight": (h, m) => `${h} h ${m} of daylight`,
    "wx.normal": "within the seasonal normal",
    "wx.aboveNormal": (d) => `${d} above normal`, "wx.belowNormal": (d) => `${d} below normal`,
    "windDirs": ["from the north", "from the north-east", "from the east", "from the south-east", "from the south", "from the south-west", "from the west", "from the north-west"],
    "rain.label": "Rain in the next 2 hours",
    "moon": ["New moon", "Waxing crescent", "First quarter", "Waxing gibbous", "Full moon", "Waning gibbous", "Last quarter", "Waning crescent"],
    "wmo.0": "Clear sky", "wmo.1": "Mainly clear", "wmo.2": "Partly cloudy", "wmo.3": "Overcast",
    "wmo.45": "Fog", "wmo.48": "Freezing fog", "wmo.51": "Light drizzle", "wmo.53": "Drizzle", "wmo.55": "Dense drizzle",
    "wmo.56": "Freezing drizzle", "wmo.57": "Freezing drizzle", "wmo.61": "Light rain", "wmo.63": "Rain", "wmo.65": "Heavy rain",
    "wmo.66": "Freezing rain", "wmo.67": "Freezing rain", "wmo.71": "Light snow", "wmo.73": "Snow", "wmo.75": "Heavy snow",
    "wmo.77": "Snow grains", "wmo.80": "Light showers", "wmo.81": "Showers", "wmo.82": "Heavy showers",
    "wmo.85": "Snow showers", "wmo.86": "Snow showers", "wmo.95": "Thunderstorm", "wmo.96": "Thunderstorm with hail", "wmo.99": "Severe thunderstorm",

    "card.air": "Air quality", "card.energy": "Electricity", "card.system": "System", "card.processes": "Top processes",
    "card.storage": "Storage", "card.devices": "Devices", "card.cities": "Cities", "card.warnings": "Active warnings",
    "card.radar": "Rain radar", "card.airPollen": "Air and pollen", "card.next48": "Next 48 hours", "card.week": "7 days",
    "card.snow": "Snow", "card.machine": "My machine", "card.changes": "What changed", "card.incidents": "Incidents",
    "card.network": "Network", "card.year": "Year", "card.lights": "Lights", "card.aircon": "Air conditioning",
    "card.houseEmpty": "Smart home",
    "house.empty": "Nothing configured yet. Add a Govee API key or Daikin units in config.json to control them from here.",
    "cities.meta": "current temperature · today's min/max",

    "sys.network": "Network", "sys.upFor": (d) => `on for ${d}`, "sys.diskTemp": "Disk temperature", "sys.liquid": "Liquid (AIO)",
    "sys.gpuDetail": "GPU hotspot / VRAM", "sys.ramTemp": "RAM temperature",
    "hist.temp": "Temp°", "hist.load": "Load %", "hist.network": "Network", "hist.latency": "Latency", "hist.fans": "Fans", "hist.power": "Power",
    "range.1h": "1 h", "range.6h": "6 h", "range.12h": "12 h", "range.1d": "1 d", "range.7d": "7 d", "range.30d": "30 d",
    "hist.collecting": "History being collected…",
    "hist.liquid": "Liquid", "hist.disk": "Disk", "hist.down": "↓ Down", "hist.up": "↑ Up", "hist.case": "Case", "hist.internet": "Internet",
    "hist.incident": "incident", "hist.update": "update",
    "hist.today": (a, b) => `${a}–${b} °C today`,

    "unit.gb": "GB", "unit.tb": "TB", "unit.mbs": "MB/s", "unit.kbs": "KB/s", "unit.rpm": "rpm", "unit.day": "d", "unit.whDay": "Wh/d",
    "fan.kraken": "Kraken", "fan.nzxt": "NZXT", "fan.gpu": "GPU", "fan.motherboard": "MB",
    "hourFmt": (h) => `${String(h).padStart(2, "0")}:00`,

    "warn.line": (area, sev) => `${area} · ${sev} warning`,
    "sev.yellow": "yellow", "sev.orange": "orange", "sev.red": "red",
    "alert.thunderstorm": "Thunderstorms", "alert.heat": "Heatwave", "alert.cold": "Extreme cold", "alert.rainFlood": "Rain and flooding",
    "alert.rain": "Rain", "alert.flood": "Flooding", "alert.wind": "Strong wind", "alert.snowIce": "Snow and ice", "alert.fog": "Fog",
    "alert.avalanche": "Avalanches", "alert.forestFire": "Forest fires", "alert.coastal": "Coastal flooding", "alert.warning": "Warning",

    "hourly.unavailable": "Hourly forecast unavailable",
    "hourly.legend": "time · sky · temperature · rain (mm) · probability · wind (km/h)",
    "week.day": "Day", "week.sky": "Sky", "week.minmax": "Min / Max", "week.rain": "Rain", "week.wind": "Wind · gusts", "week.uv": "UV",
    "week.sun": "Sunrise / sunset", "today": "Today", "today.lower": "today", "yesterday.lower": "yesterday",

    "radar.recenter": "Recenter on the selected city", "radar.unavailable": "Radar unavailable", "radar.forecast": " (forecast)",

    "light": "Light", "houseError": (who, msg) => `${who}: ${msg}`, "aircon": (name) => `AC ${name}`, "failed": "failed", "requestFailed": "request failed",
    "daikin.mode": ["Auto", "Dry", "Cool", "Heat", "Fan"],
    "daikin.rate": ["Fan auto", "Quiet", "Fan 1", "Fan 2", "Fan 3", "Fan 4", "Fan 5"],
    "daikin.dir": ["Fixed vanes", "Vanes ↕", "Vanes ↔", "Vanes 3D"],
    "govee.colors": ["White", "Red", "Orange", "Yellow", "Green", "Cyan", "Blue", "Purple", "Pink"],
    "confirm.cancel": "Cancel", "confirm.ok": "Confirm",
    "confirm.apply": (name) => `Apply this setting to ${name}?`,
    "confirm.turnOn": (name) => `Turn on ${name}?`,
    "confirm.setTemp": (name, temp) => `Set ${name} to ${temp}°?`,
    "scenes.custom": "Custom", "scenes.none": "No scenes", "scene": "Scene", "moreColors": "More colors",
    "colorTemp": (k) => `Color temperature (${k} K)`, "brightness": (b) => `Brightness (${b} %)`,
    "on": "On", "off": "Off", "unreachable": "unreachable", "outside": (t) => `outside ${t}°`,

    "aqi": ["Good", "Fair", "Moderate", "Poor", "Very poor", "Extreme"],
    "pollen.names": ["Alder", "Birch", "Grass", "Mugwort", "Olive", "Ragweed"],
    "pollen.low": "low", "pollen.moderate": "moderate", "pollen.high": "high",
    "pollen.line": "Pollen", "pollen.none": "No pollen detected over the next 4 days",
    "pollen.title": "Pollen · 4 days", "pollen.species": "Species", "pollen.today": "Today",
    "pollen.legend": "Daily peak in grains/m³ · low &lt; 25 · moderate &lt; 60 · high above",

    "tempo.colors": { 1: "Blue", 2: "White", 3: "Red" }, "tempo.redTomorrow": "Tempo Red tomorrow",
    "energy.tempo": "Tempo day", "energy.tomorrow": (c) => `tomorrow: ${c}`, "energy.tomorrowUnknown": "tomorrow: not known yet",
    "energy.carbon": "Grid carbon", "carbon": ["very low", "low", "moderate", "high"],
    "energy.emissions": "Machine emissions", "energy.cpuGpu": (w) => `CPU + GPU: ${w} W`, "energy.today": "Today", "energy.hoursOn": (h) => `${h} h on`,
    "energy.avgW": (w) => `${w} W avg`, "energy.month": "This month", "energy.projection": (k) => `projection ${k} kWh`,
    "energy.vs": (pct, month) => `${pct} % vs ${month}`, "energy.nextMonth": "comparison from next month",

    "snow.isotherm": (m) => `0 °C isotherm · ${m} m`, "snow.none": "No snow",
    "snow.noneDetail": (n) => `No snow cover or snowfall expected at the ${n} tracked spots`,
    "snow.onSite": (t) => `${t} on site`, "snow.coming": (cm) => `<b style="color:#8fd6ff">+${cm} cm</b><br>expected within 5 days`,
    "snow.noFall": "no snowfall<br>expected within 5 days", "snow.unavailable": "Snow data unavailable",

    "net.metaYoung": (target, n) => `${target} · measuring (${plural(n, "reading", "readings")})`,
    "net.meta": (target, n) => `${target} · ${n} readings over 24 h`,
    "net.latency": "Latency", "net.noAnswer": "no answer", "net.lastFailed": "last attempt failed", "net.last": "last measurement",
    "net.avg": "24 h average", "net.notEnough": "not enough readings yet", "net.peak": (ms) => `peak ${ms} ms`,
    "net.jitter": "Jitter", "net.jitterSub": "gap between two readings", "net.loss": "24 h loss",
    "net.unstable": "unstable connection", "net.stable": "stable connection",

    "year.starting": "Daily history just started, this card will fill up day by day.",
    "year.meta": (n, date) => `${plural(n, "day", "days")} since ${date}`,
    "year.used": "Used", "year.over": (n) => `over ${plural(n, "day", "days")}`,
    "year.cost": "Estimated cost", "year.atPrice": (p) => `at ${p} €/kWh`, "year.noPrice": "no price set",
    "year.on": "Time on", "year.perDay": (h) => `${h} h a day on average`,
    "year.avg": "Average", "year.daily": "daily consumption",
    "year.since": (date) => `since ${date}`, "year.current": "in progress",
    "year.note": (date) => `This card only reads the daily table, started on ${date}: it doesn't backfill earlier days. The Overview "This month" total comes from 30 days of raw samples, hence the gap. Both will match once the table covers a whole month.`,
    "year.strip": (n, scale) => `Last ${n} days · height: hours on · color: max GPU temperature${scale}`,

    "chg.latency": ["Latency degraded", (c) => `${c.recent} ms over the last hour, against ${c.usual} ms usually`],
    "chg.packetLoss": ["Unstable connection", (c) => `${nb(c.pct, 1)} % of network tests failed in the last hour`],
    "chg.thermal": [(c) => `${c.part} warmer than before`, (c) => `${c.recent} °C under load this week, against ${c.before} °C three weeks ago: dust, thermal paste, or a warmer room`],
    "chg.consumption": ["Consumption up", (c) => `${nb(c.yesterday, 1)} kWh yesterday, against ${nb(c.usual, 1)} kWh on previous days`],
    "chg.diskDrop": ["Disk space dropping", (c) => `${c.lost} GB less than ${c.gapDays === 1 ? "yesterday" : "the day before yesterday"}, ${c.free} GB free`],
    "chg.incidents": ["Incidents speeding up", (c) => `${c.week} this week, against ${nb(c.perWeek, 1)} a week over the month`],

    "lhm.unreachable": "LibreHardwareMonitor unreachable: start it and enable Options → Remote Web Server (port 8085).",
    "lhm.noSensor": "LHM answers but no sensor was found: run it as administrator.",
    "lhm.agentDown": "Agent unreachable, reconnecting as soon as it is back…",
    "ssd.prefix": "SSD: ", "ssd.life": (p) => `${p} % life`, "ssd.written": (tb) => `${tb} TB written`,
    "ssd.years": (y) => `about ${y} years left at this pace`, "ssd.hours": (k) => `about ${k},000 hours of use left`,

    "banner.liquid": "AIO liquid", "banner.disk": "Disk",
    "proc.name": "Process", "proc.cpu": "CPU load", "proc.mem": "Memory",
    "disk.free": (free, pct) => `${free} GB free · ${pct} %`,
    "battery.stale": "Last known value, device asleep", "battery.none": "No battery found",

    "crash.none30": "No incident in 30 days", "crash.today": "Incident today",
    "crash.daysWithout": (n) => `${plural(n, "day", "days")} without incident`,
    "crash.freezes": (n) => plural(n, "freeze", "freezes"), "crash.freezeNote": "(the machine had stopped responding)",
    "crash.cuts": (n) => plural(n, "hard power cut", "hard power cuts"), "crash.cutNote": "(samples up to the end)",
    "crash.count": (n) => plural(n, "incident", "incidents"),
    "crash.over30": (w) => `over 30 days${w ? ` · ${w} this week` : ""}`,
    "nature.freeze": "Freeze", "nature.cut": "Hard cut", "nature.undetermined": "?",
    "crash.silence": (m) => `${m} min of silence`, "crash.at": (date, time) => `${date} at ${time}`,
    "incident.bsod": "Blue screen", "incident.hardware": "Hardware error", "incident.unexpected": "Unexpected shutdown", "incident.powerLoss": "Power loss or hang",
    "incidentLong.bsod": "Blue screen (BugCheck)", "incidentLong.hardware": "Hardware error (WHEA)",
    "incidentLong.unexpected": "Unexpected shutdown", "incidentLong.powerLoss": "Power loss or hang (Kernel-Power 41)",
    "crash.cols": ["Time", "CPU", "GPU", "Liq.", "RAM"],
    "hint.cpuHot": (h) => `CPU overheating likely: ${h.temp} °C in the quarter hour before the shutdown`,
    "hint.gpuHot": (h) => `GPU very hot: ${h.temp} °C just before the shutdown`,
    "hint.liquidHot": (h) => `AIO liquid at ${h.temp} °C: check the pump or the radiator`,
    "hint.ramFull": (h) => `RAM full (${h.pct} %): possibly out of memory`,
    "hint.bsod": (h) => `BSOD with bugcheck ${h.code}: look the code up, often the GPU driver or RAM`,
    "hint.whea": () => "WHEA hardware error: suspect the CPU, the power supply or overclocking",
    "hint.freeze": (h) => `Samples stop ${silenceText(h.silence)} before the logged shutdown: the machine had already stopped responding. This is a freeze followed by a reset, not a power cut. Look at the graphics driver.`,
    "hint.cut": (h) => `Normal sensors until ${h.silence} s before the shutdown: hard power cut. Check the power supply, the cable, or an instant reset.`,
    "hint.noData": () => "No sample in the half hour before the incident: the agent was probably not running, nothing to conclude.",
    "marker.gpuDriver": "GPU driver", "marker.bios": "BIOS", "marker.windows": (kb) => `Windows ${kb}`,

    "rel.today": "today", "rel.yesterday": "yesterday", "rel.days": (d) => `${d} d ago`,
    "rel.months": (m) => `${m} months ago`, "rel.years": (y) => plural(y, "year", "years") + " ago",
    "mach.unavailable": "Information unavailable: the WMI query returned nothing.",
    "mach.cpu": "Processor", "mach.cores": (c, t) => `${c} cores / ${t} threads`, "mach.gpu": "Graphics card",
    "mach.driver": (v) => `driver ${v}`, "mach.board": "Motherboard", "mach.ram": "Memory", "mach.disks": "Disks",
    "mach.windows": "Windows", "mach.hotfix": (kb) => `latest update ${kb}`,
    "tools.installed": (v) => `installed ${v}`, "tools.upToDate": (v) => `up to date (${v})`, "tools.new": "new",
    "tools.none": "No tools configured in config.json",
    "hol.today": (n) => `${n}, public holiday`, "hol.tomorrow": (n) => `${n} tomorrow, public holiday`,
    "hol.on": (n, day) => `${n} on ${day}, public holiday`,
    "school.until": (n, date) => `${n}, until ${date}`, "school.tomorrow": (n) => `${n} from tomorrow`, "school.in": (n, d) => `${n} in ${d} days`,
    "pub.newYear": "New Year's Day", "pub.easterMonday": "Easter Monday", "pub.labourDay": "Labour Day", "pub.victoryDay": "Victory in Europe Day",
    "pub.ascension": "Ascension Day", "pub.whitMonday": "Whit Monday", "pub.bastilleDay": "Bastille Day", "pub.assumption": "Assumption Day",
    "pub.allSaints": "All Saints' Day", "pub.armistice": "Armistice Day", "pub.christmas": "Christmas Day", "pub.other": "Public holiday",
    "break.autumn": "Autumn break", "break.christmas": "Christmas break", "break.winter": "Winter break", "break.spring": "Spring break",
    "break.ascensionBridge": "Ascension bridge", "break.summer": "Summer break", "break.other": "School break",
    "energy.tempoLeft": (r, w) => `${r} red and ${w} white days left`,
    "card.pressure": "Pressure", "pressure.steady": "Steady", "pressure.rising": "Rising", "pressure.falling": "Falling",
    "pressure.risingFast": "Rising fast", "pressure.fallingFast": "Falling fast", "pressure.delta": (d) => `${d} hPa in 3 h`,
    "pressure.past": "24 h ago", "pressure.now": "now", "pressure.next": "in 24 h",
    "card.fuel": "Fuel", "fuel.gazole": "Diesel", "fuel.sp95": "SP95", "fuel.e10": "SP95-E10", "fuel.sp98": "SP98", "fuel.e85": "E85", "fuel.gplc": "LPG",
    "fuel.km": (d) => `${d} km`, "fuel.none": "No recent price nearby",
    "card.services": "Services", "svc.waiting": "first check…",
    "svc.error": (code, since) => `HTTP ${code} since ${since}`, "svc.down": (since) => `unreachable since ${since}`,
    "svc.pillDown": (n) => `${n} unreachable`, "svc.pillError": (n) => `${n} in error`,
    "win.reboot": "Restart needed", "win.updates": (n) => plural(n, "update waiting", "updates waiting"),
    "win.rebootLong": "A restart is pending.", "win.updatesList": (n, list) => `${plural(n, "update", "updates")} to install: ${list}`,
    "media.play": "Play", "media.pause": "Pause",
    "nameday": (n) => `Name day: ${n}`,
  },

  fr: {
    "tab.overview": "Accueil", "tab.weather": "Météo", "tab.machine": "Machine", "tab.tools": "Outils", "tab.house": "Maison",
    "loading": "Chargement…", "searching": "Recherche…", "unavailable": "Indisponible",
    "config.error": "Impossible de lire la configuration de l'agent. agent.js est-il lancé ?",

    "wx.feels": "Ressenti", "wx.humidity": "Humidité", "wx.wind": "Vent", "wx.uv": "UV",
    "wx.max": "max", "wx.min": "min", "wx.gustsLabel": "Rafales", "wx.rainToday": "Pluie auj.", "wx.none": "aucune", "wx.uvMax": "UV max",
    "wx.unavailable": "Météo indisponible",
    "sun.rise": "Lever", "sun.set": "Coucher", "sun.daylight": (h, m) => `${h} h ${m} de jour`,
    "wx.normal": "dans la normale saisonnière",
    "wx.aboveNormal": (d) => `${d} au-dessus de la normale`, "wx.belowNormal": (d) => `${d} sous la normale`,
    "windDirs": ["du nord", "de nord-est", "d'est", "de sud-est", "du sud", "de sud-ouest", "d'ouest", "de nord-ouest"],
    "rain.label": "Pluie dans les 2 heures",
    "moon": ["Nouvelle lune", "Premier croissant", "Premier quartier", "Gibbeuse croissante", "Pleine lune", "Gibbeuse décroissante", "Dernier quartier", "Dernier croissant"],
    "wmo.0": "Ciel dégagé", "wmo.1": "Peu nuageux", "wmo.2": "Partiellement nuageux", "wmo.3": "Couvert",
    "wmo.45": "Brouillard", "wmo.48": "Brouillard givrant", "wmo.51": "Bruine légère", "wmo.53": "Bruine", "wmo.55": "Bruine dense",
    "wmo.56": "Bruine verglaçante", "wmo.57": "Bruine verglaçante", "wmo.61": "Pluie faible", "wmo.63": "Pluie", "wmo.65": "Pluie forte",
    "wmo.66": "Pluie verglaçante", "wmo.67": "Pluie verglaçante", "wmo.71": "Neige faible", "wmo.73": "Neige", "wmo.75": "Neige forte",
    "wmo.77": "Grésil", "wmo.80": "Averses légères", "wmo.81": "Averses", "wmo.82": "Averses fortes",
    "wmo.85": "Averses de neige", "wmo.86": "Averses de neige", "wmo.95": "Orage", "wmo.96": "Orage avec grêle", "wmo.99": "Orage violent",

    "card.air": "Qualité de l'air", "card.energy": "Électricité", "card.system": "Système", "card.processes": "Top processus",
    "card.storage": "Stockage", "card.devices": "Périphériques", "card.cities": "Villes", "card.warnings": "Vigilances en cours",
    "card.radar": "Radar de pluie", "card.airPollen": "Air et pollens", "card.next48": "Prochaines 48 heures", "card.week": "7 jours",
    "card.snow": "Neige", "card.machine": "Ma machine", "card.changes": "Ce qui a changé", "card.incidents": "Incidents",
    "card.network": "Réseau", "card.year": "Année", "card.lights": "Lampes", "card.aircon": "Climatisation",
    "card.houseEmpty": "Domotique",
    "house.empty": "Rien de configuré pour l'instant. Ajoute une clé API Govee ou des clims Daikin dans config.json pour les piloter d'ici.",
    "cities.meta": "température du moment · min/max du jour",

    "sys.network": "Réseau", "sys.upFor": (d) => `allumé depuis ${d}`, "sys.diskTemp": "Température disques", "sys.liquid": "Liquide (AIO)",
    "sys.gpuDetail": "GPU hotspot / VRAM", "sys.ramTemp": "Température RAM",
    "hist.temp": "Temp°", "hist.load": "Charge %", "hist.network": "Réseau", "hist.latency": "Latence", "hist.fans": "Ventilos", "hist.power": "Conso",
    "range.1h": "1 h", "range.6h": "6 h", "range.12h": "12 h", "range.1d": "1 j", "range.7d": "7 j", "range.30d": "30 j",
    "hist.collecting": "Historique en cours de collecte…",
    "hist.liquid": "Liquide", "hist.disk": "Disque", "hist.down": "↓ Récep.", "hist.up": "↑ Envoi", "hist.case": "Boîtier", "hist.internet": "Internet",
    "hist.incident": "incident", "hist.update": "mise à jour",
    "hist.today": (a, b) => `${a}–${b} °C auj.`,

    "unit.gb": "Go", "unit.tb": "To", "unit.mbs": "Mo/s", "unit.kbs": "Ko/s", "unit.rpm": "tr/min", "unit.day": "j", "unit.whDay": "Wh/j",
    "fan.kraken": "Kraken", "fan.nzxt": "NZXT", "fan.gpu": "GPU", "fan.motherboard": "CM",
    "hourFmt": (h) => `${String(h).padStart(2, "0")}h`,

    "warn.line": (area, sev) => `${area} · vigilance ${sev}`,
    "sev.yellow": "jaune", "sev.orange": "orange", "sev.red": "rouge",
    "alert.thunderstorm": "Orages", "alert.heat": "Canicule", "alert.cold": "Grand froid", "alert.rainFlood": "Pluie-inondation",
    "alert.rain": "Pluie", "alert.flood": "Inondation", "alert.wind": "Vent violent", "alert.snowIce": "Neige-verglas", "alert.fog": "Brouillard",
    "alert.avalanche": "Avalanches", "alert.forestFire": "Feux de forêt", "alert.coastal": "Vagues-submersion", "alert.warning": "Vigilance",

    "hourly.unavailable": "Prévisions horaires indisponibles",
    "hourly.legend": "heure · ciel · température · pluie (mm) · probabilité · vent (km/h)",
    "week.day": "Jour", "week.sky": "Ciel", "week.minmax": "Min / Max", "week.rain": "Pluie", "week.wind": "Vent · raf.", "week.uv": "UV",
    "week.sun": "Lever / Coucher", "today": "Aujourd'hui", "today.lower": "aujourd'hui", "yesterday.lower": "hier",

    "radar.recenter": "Recentrer sur la ville sélectionnée", "radar.unavailable": "Radar indisponible", "radar.forecast": " (prévision)",

    "light": "Lampe", "houseError": (who, msg) => `${who} : ${msg}`, "aircon": (name) => `Clim ${name}`, "failed": "échec", "requestFailed": "requête impossible",
    "daikin.mode": ["Auto", "Déshum.", "Froid", "Chaud", "Ventil."],
    "daikin.rate": ["Vent. auto", "Silencieux", "Vent. 1", "Vent. 2", "Vent. 3", "Vent. 4", "Vent. 5"],
    "daikin.dir": ["Volets fixes", "Volets ↕", "Volets ↔", "Volets 3D"],
    "govee.colors": ["Blanc", "Rouge", "Orange", "Jaune", "Vert", "Cyan", "Bleu", "Violet", "Rose"],
    "confirm.cancel": "Annuler", "confirm.ok": "Confirmer",
    "confirm.apply": (name) => `Appliquer ce réglage à la clim ${name} ?`,
    "confirm.turnOn": (name) => `Allumer la clim ${name} ?`,
    "confirm.setTemp": (name, temp) => `Régler la clim ${name} à ${temp}° ?`,
    "scenes.custom": "Personnalisées", "scenes.none": "Aucune scène", "scene": "Scène", "moreColors": "Plus de couleurs",
    "colorTemp": (k) => `Température de couleur (${k} K)`, "brightness": (b) => `Luminosité (${b} %)`,
    "on": "Allumée", "off": "Éteinte", "unreachable": "injoignable", "outside": (t) => `dehors ${t}°`,

    "aqi": ["Bon", "Correct", "Dégradé", "Mauvais", "Très mauvais", "Extrême"],
    "pollen.names": ["Aulne", "Bouleau", "Graminées", "Armoise", "Olivier", "Ambroisie"],
    "pollen.low": "faible", "pollen.moderate": "modéré", "pollen.high": "élevé",
    "pollen.line": "Pollens", "pollen.none": "Aucun pollen détecté sur les 4 prochains jours",
    "pollen.title": "Pollens · 4 jours", "pollen.species": "Espèce", "pollen.today": "Auj.",
    "pollen.legend": "Pic de la journée en grains/m³ · faible &lt; 25 · modéré &lt; 60 · élevé au-delà",

    "tempo.colors": { 1: "Bleu", 2: "Blanc", 3: "Rouge" }, "tempo.redTomorrow": "Tempo Rouge demain",
    "energy.tempo": "Jour Tempo", "energy.tomorrow": (c) => `demain : ${c}`, "energy.tomorrowUnknown": "demain : pas encore connu",
    "energy.carbon": "Carbone du réseau", "carbon": ["très bas", "bas", "modéré", "élevé"],
    "energy.emissions": "Émissions machine", "energy.cpuGpu": (w) => `CPU + GPU : ${w} W`, "energy.today": "Aujourd'hui", "energy.hoursOn": (h) => `${h} h allumé`,
    "energy.avgW": (w) => `${w} W moy.`, "energy.month": "Ce mois", "energy.projection": (k) => `projection ${k} kWh`,
    "energy.vs": (pct, month) => `${pct} % vs ${month}`, "energy.nextMonth": "comparatif dès le mois prochain",

    "snow.isotherm": (m) => `isotherme 0 °C · ${m} m`, "snow.none": "Pas de neige",
    "snow.noneDetail": (n) => `Aucun enneigement ni chute prévue sur les ${n} points suivis`,
    "snow.onSite": (t) => `${t} sur place`, "snow.coming": (cm) => `<b style="color:#8fd6ff">+${cm} cm</b><br>attendus sous 5 jours`,
    "snow.noFall": "aucune chute<br>prévue sous 5 jours", "snow.unavailable": "Données d'enneigement indisponibles",

    "net.metaYoung": (target, n) => `${target} · mesure en cours (${plural(n, "relevé", "relevés")})`,
    "net.meta": (target, n) => `${target} · ${n} relevés sur 24 h`,
    "net.latency": "Latence", "net.noAnswer": "aucune réponse", "net.lastFailed": "dernière tentative échouée", "net.last": "dernière mesure",
    "net.avg": "Moyenne 24 h", "net.notEnough": "pas encore assez de relevés", "net.peak": (ms) => `pic à ${ms} ms`,
    "net.jitter": "Gigue", "net.jitterSub": "écart entre deux relevés", "net.loss": "Pertes 24 h",
    "net.unstable": "connexion instable", "net.stable": "connexion stable",

    "year.starting": "L'historique journalier vient de démarrer, cette carte se remplira jour après jour.",
    "year.meta": (n, date) => `${plural(n, "jour", "jours")} depuis le ${date}`,
    "year.used": "Consommé", "year.over": (n) => `sur ${plural(n, "jour", "jours")}`,
    "year.cost": "Coût estimé", "year.atPrice": (p) => `au tarif ${p} €/kWh`, "year.noPrice": "aucun prix configuré",
    "year.on": "Allumé", "year.perDay": (h) => `${h} h par jour en moyenne`,
    "year.avg": "Moyenne", "year.daily": "consommation quotidienne",
    "year.since": (date) => `depuis le ${date}`, "year.current": "en cours",
    "year.note": (date) => `Cette carte ne lit que la table journalière, démarrée le ${date} : elle ne rattrape pas les jours antérieurs. Le total « Ce mois » de l'Accueil est calculé sur 30 jours d'échantillons bruts, d'où l'écart. Les deux se rejoindront quand la table aura couvert un mois entier.`,
    "year.strip": (n, scale) => `${n} derniers jours · hauteur : heures d'allumage · couleur : température GPU max${scale}`,

    "chg.latency": ["Latence dégradée", (c) => `${c.recent} ms sur la dernière heure, contre ${c.usual} ms d'habitude`],
    "chg.packetLoss": ["Connexion instable", (c) => `${nb(c.pct, 1)} % des tests réseau ont échoué dans la dernière heure`],
    "chg.thermal": [(c) => `${c.part} plus chaud qu'avant`, (c) => `${c.recent} °C en charge cette semaine, contre ${c.before} °C il y a trois semaines : empoussièrement, pâte thermique, ou pièce plus chaude`],
    "chg.consumption": ["Consommation en hausse", (c) => `${nb(c.yesterday, 1)} kWh hier, contre ${nb(c.usual, 1)} kWh les jours précédents`],
    "chg.diskDrop": ["Espace disque en baisse", (c) => `${c.lost} Go de moins ${c.gapDays === 1 ? "qu'hier" : "qu'avant-hier"}, ${c.free} Go libres`],
    "chg.incidents": ["Incidents en accélération", (c) => `${c.week} cette semaine, contre ${nb(c.perWeek, 1)} par semaine sur le mois`],

    "lhm.unreachable": "LibreHardwareMonitor injoignable : lance-le et active Options → Remote Web Server (port 8085).",
    "lhm.noSensor": "LHM répond mais aucun capteur trouvé : lance-le en administrateur.",
    "lhm.agentDown": "Agent injoignable, reconnexion automatique dès son retour…",
    "ssd.prefix": "SSD : ", "ssd.life": (p) => `${p} % de vie`, "ssd.written": (tb) => `${tb} To écrits`,
    "ssd.years": (y) => `encore ~${y} ans à ce rythme`, "ssd.hours": (k) => `encore ~${k} 000 h d'allumage`,

    "banner.liquid": "Liquide AIO", "banner.disk": "Disque",
    "proc.name": "Processus", "proc.cpu": "Charge CPU", "proc.mem": "Mémoire",
    "disk.free": (free, pct) => `${free} Go libres · ${pct} %`,
    "battery.stale": "Dernière valeur connue, appareil en veille", "battery.none": "Aucune batterie détectée",

    "crash.none30": "Aucun incident sur 30 jours", "crash.today": "Incident aujourd'hui",
    "crash.daysWithout": (n) => `${plural(n, "jour", "jours")} sans incident`,
    "crash.freezes": (n) => plural(n, "gel", "gels"), "crash.freezeNote": "(la machine ne répondait plus)",
    "crash.cuts": (n) => plural(n, "coupure sèche", "coupures sèches"), "crash.cutNote": "(mesures jusqu'au bout)",
    "crash.count": (n) => plural(n, "incident", "incidents"),
    "crash.over30": (w) => `sur 30 jours${w ? ` · ${w} cette semaine` : ""}`,
    "nature.freeze": "Gel", "nature.cut": "Coupure sèche", "nature.undetermined": "?",
    "crash.silence": (m) => `${m} min de silence`, "crash.at": (date, time) => `${date} à ${time}`,
    "incident.bsod": "Écran bleu", "incident.hardware": "Erreur matérielle", "incident.unexpected": "Arrêt inattendu", "incident.powerLoss": "Coupure ou blocage",
    "incidentLong.bsod": "Écran bleu (BugCheck)", "incidentLong.hardware": "Erreur matérielle (WHEA)",
    "incidentLong.unexpected": "Arrêt inattendu", "incidentLong.powerLoss": "Coupure ou blocage (Kernel-Power 41)",
    "crash.cols": ["Heure", "CPU", "GPU", "Liq.", "RAM"],
    "hint.cpuHot": (h) => `Surchauffe CPU probable : ${h.temp} °C dans le quart d'heure précédant l'arrêt`,
    "hint.gpuHot": (h) => `GPU très chaud : ${h.temp} °C juste avant l'arrêt`,
    "hint.liquidHot": (h) => `Liquide AIO à ${h.temp} °C : pompe ou radiateur à vérifier`,
    "hint.ramFull": (h) => `RAM saturée (${h.pct} %) : piste manque de mémoire (OOM)`,
    "hint.bsod": (h) => `BSOD avec bugcheck ${h.code} : code à chercher, souvent pilote GPU ou RAM`,
    "hint.whea": () => "Erreur matérielle WHEA : CPU, alimentation ou overclocking à suspecter",
    "hint.freeze": (h) => `Les mesures s'arrêtent ${silenceText(h.silence)} avant l'arrêt journalisé : la machine ne répondait déjà plus. C'est un gel suivi d'un reset, pas une coupure d'alimentation. Chercher côté pilote graphique.`,
    "hint.cut": (h) => `Capteurs normaux jusqu'à ${h.silence} s de l'arrêt : coupure sèche. Alimentation, câble ou reset immédiat.`,
    "hint.noData": () => "Aucune mesure dans la demi-heure précédant l'incident : l'agent ne tournait probablement pas, rien à conclure.",
    "marker.gpuDriver": "Pilote GPU", "marker.bios": "BIOS", "marker.windows": (kb) => `Windows ${kb}`,

    "rel.today": "aujourd'hui", "rel.yesterday": "hier", "rel.days": (d) => `il y a ${d} j`,
    "rel.months": (m) => `il y a ${m} mois`, "rel.years": (y) => "il y a " + plural(y, "an", "ans"),
    "mach.unavailable": "Informations indisponibles : la requête WMI n'a rien renvoyé.",
    "mach.cpu": "Processeur", "mach.cores": (c, t) => `${c} cœurs / ${t} threads`, "mach.gpu": "Carte graphique",
    "mach.driver": (v) => `pilote ${v}`, "mach.board": "Carte mère", "mach.ram": "Mémoire", "mach.disks": "Disques",
    "mach.windows": "Windows", "mach.hotfix": (kb) => `dernier correctif ${kb}`,
    "tools.installed": (v) => `installée ${v}`, "tools.upToDate": (v) => `à jour (${v})`, "tools.new": "nouvelle",
    "tools.none": "Aucun outil configuré dans config.json",
    "hol.today": (n) => `${n}, jour férié`, "hol.tomorrow": (n) => `${n} demain, jour férié`,
    "hol.on": (n, day) => `${n} ${day}, jour férié`,
    "school.until": (n, date) => `${n}, jusqu'au ${date}`, "school.tomorrow": (n) => `${n} dès demain`, "school.in": (n, d) => `${n} dans ${d} jours`,
    "pub.newYear": "Jour de l'an", "pub.easterMonday": "Lundi de Pâques", "pub.labourDay": "1er mai", "pub.victoryDay": "8 mai",
    "pub.ascension": "Ascension", "pub.whitMonday": "Lundi de Pentecôte", "pub.bastilleDay": "14 juillet", "pub.assumption": "Assomption",
    "pub.allSaints": "Toussaint", "pub.armistice": "11 novembre", "pub.christmas": "Noël", "pub.other": "Jour férié",
    "break.autumn": "Vacances de la Toussaint", "break.christmas": "Vacances de Noël", "break.winter": "Vacances d'hiver", "break.spring": "Vacances de printemps",
    "break.ascensionBridge": "Pont de l'Ascension", "break.summer": "Vacances d'été", "break.other": "Vacances scolaires",
    "energy.tempoLeft": (r, w) => `reste ${r} rouges et ${w} blancs`,
    "card.pressure": "Pression atmosphérique", "pressure.steady": "Stable", "pressure.rising": "En hausse", "pressure.falling": "En baisse",
    "pressure.risingFast": "En forte hausse", "pressure.fallingFast": "En forte baisse", "pressure.delta": (d) => `${d} hPa en 3 h`,
    "pressure.past": "il y a 24 h", "pressure.now": "maintenant", "pressure.next": "dans 24 h",
    "card.fuel": "Carburant", "fuel.gazole": "Gazole", "fuel.sp95": "SP95", "fuel.e10": "SP95-E10", "fuel.sp98": "SP98", "fuel.e85": "E85", "fuel.gplc": "GPLc",
    "fuel.km": (d) => `${d} km`, "fuel.none": "Aucun prix récent autour",
    "card.services": "Services", "svc.waiting": "première vérification…",
    "svc.error": (code, since) => `HTTP ${code} depuis ${since}`, "svc.down": (since) => `injoignable depuis ${since}`,
    "svc.pillDown": (n) => `${n} injoignable`, "svc.pillError": (n) => `${n} en erreur`,
    "win.reboot": "Redémarrage nécessaire", "win.updates": (n) => plural(n, "mise à jour en attente", "mises à jour en attente"),
    "win.rebootLong": "Un redémarrage est en attente.", "win.updatesList": (n, list) => `${plural(n, "mise à jour", "mises à jour")} à installer : ${list}`,
    "media.play": "Lecture", "media.pause": "Pause",
    "nameday": (n) => `Fête : ${n}`,
  },
};

let LANG = "en";
export let LOCALE = "en-GB";
export function setLang(lang) {
  LANG = I18N[lang] ? lang : "en";
  // en-GB keeps °C, km/h and day-month dates, which match the units used everywhere.
  LOCALE = LANG === "fr" ? "fr-FR" : "en-GB";
  document.documentElement.lang = LANG;
  document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
}
export function t(key, ...args) {
  const v = I18N[LANG][key];
  if (v === undefined) return key;
  return typeof v === "function" ? v(...args) : v;
}

/* Number and date formatting follow the language: "1,7" in French, "1.7" in English. */
export const dec = (v, n = 1) => Number(v).toLocaleString(LOCALE, { minimumFractionDigits: n, maximumFractionDigits: n });
export const nb = (v, d = 0) => Number(v).toLocaleString(LOCALE, { maximumFractionDigits: d });
export const fmtDate = (d, opts) => new Date(d).toLocaleDateString(LOCALE, opts);
export const fmtTime = (d) => new Date(d).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" });
const silenceText = (s) => { const m = Math.round(s / 60); return m >= 1 ? `${m} min` : `${s} s`; };
// Local YYYY-MM-DD, the same key as dayKey() on the agent side. toISOString()
// would give UTC, still yesterday between local and UTC midnight.
export const dayKey = (d = new Date()) => d.toLocaleDateString("fr-CA");

export const relTime = (iso) => {
  if (!iso) return "";
  const d = Math.floor((Date.now() - new Date(iso)) / 86400000);
  if (d <= 0) return t("rel.today");
  if (d === 1) return t("rel.yesterday");
  if (d < 30) return t("rel.days", d);
  if (d < 365) return t("rel.months", Math.round(d / 30));
  return t("rel.years", Math.round(d / 365));
};
