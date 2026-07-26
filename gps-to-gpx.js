import fs from "fs/promises";
import path from "path";

// Константы
const R = 6371000;

// Хаверсин
const haversine = (lat1, lon1, lat2, lon2) => {
  const toRad = (v) => (v * Math.PI) / 180;

  lat1 = toRad(lat1);
  lon1 = toRad(lon1);
  lat2 = toRad(lat2);
  lon2 = toRad(lon2);

  const dLat = lat2 - lat1;
  const dLon = lon2 - lon1;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

// Интерполяция
const interpolatePoints = (start, end, stepSize) => {
  const distance = haversine(start[0], start[1], end[0], end[1]);
  const numPoints = Math.floor(distance / stepSize);

  const points = [start];

  for (let i = 1; i < numPoints; i++) {
    const lat = start[0] + (end[0] - start[0]) * (i / numPoints);
    const lon = start[1] + (end[1] - start[1]) * (i / numPoints);

    if (
      lat !== points[points.length - 1][0] ||
      lon !== points[points.length - 1][1]
    ) {
      points.push([lat, lon]);
    }
  }

  points.push(end);
  return points;
};

// Основная обработка
const processAndSplitGpsData = async (inputFile, stepSize = 1.0) => {
  const content = await fs.readFile(inputFile, "utf-8");
  const lines = content.split("\n");

  const videoTimes = {};
  const videoPoints = {};

  for (const line of lines) {
    if (!line || line.includes("$V02") || line.includes("nan")) continue;

    const parts = line.trim().split(",");

    if (parts.length > 10) {
      const videoName = parts[9];
      const timestampMs = Math.floor(parseFloat(parts[0]) * 1000);

      if (!videoTimes[videoName]) {
        videoTimes[videoName] = { start: timestampMs, end: timestampMs };
      } else {
        videoTimes[videoName].end = timestampMs;
      }

      const lat = parseFloat(parts[2]);
      const lon = parseFloat(parts[3]);

      if (!videoPoints[videoName]) {
        videoPoints[videoName] = [];
      }

      videoPoints[videoName].push([lat, lon, timestampMs]);
    }
  }

  const allLines = [];

  for (const [videoName, points] of Object.entries(videoPoints)) {
    const { start, end } = videoTimes[videoName];
    const timeDiff = end - start;

    const numPoints = points.length;
    const timeStep = timeDiff / (numPoints - 1);

    for (let i = 0; i < numPoints - 1; i++) {
      const startPoint = points[i];
      const endPoint = points[i + 1];

      const interpolated = interpolatePoints(
        startPoint.slice(0, 2),
        endPoint.slice(0, 2),
        stepSize,
      );

      for (let j = 0; j < interpolated.length; j++) {
        const [lat, lon] = interpolated[j];

        const timestamp =
          start +
          Math.floor(i * timeStep) +
          Math.floor((j * timeStep) / interpolated.length);

        const roundedLat = Number(lat.toFixed(6));
        const roundedLon = Number(lon.toFixed(6));

        if (
          allLines.length === 0 ||
          allLines[allLines.length - 1][1] !== roundedLat ||
          allLines[allLines.length - 1][2] !== roundedLon
        ) {
          allLines.push([timestamp, roundedLat, roundedLon, videoName]);
        }
      }
    }
  }

  // Группировка по файлам
  const videoFileMap = {};

  for (const line of allLines) {
    const videoName = line[3].replace(".MP4", "");

    if (!videoFileMap[videoName]) {
      videoFileMap[videoName] = [];
    }

    videoFileMap[videoName].push(line);
  }

  const destDir = path.dirname(inputFile);

  // Запись файлов (параллельно)
  await Promise.all(
    Object.entries(videoFileMap).map(async ([videoName, lines]) => {
      const content = lines.map((l) => l.join(",")).join("\n");

      await fs.writeFile(
        path.join(destDir, `${videoName}.txt`),
        content,
        "utf-8",
      );
    }),
  );
};

// Конвертация в GPX
const convertToGpx = async (inputFile) => {
  const content = await fs.readFile(inputFile, "utf-8");
  const lines = content.split("\n");

  const videoTracks = {};

  for (const line of lines) {
    if (!line.trim()) continue;

    const parts = line.split(",");
    if (parts.length !== 4) continue;

    let [timestamp, lat, lon, filename] = parts;

    timestamp = parseInt(timestamp, 10);

    const seconds = Math.floor(timestamp / 1000);
    const millis = timestamp % 1000;

    const date = new Date(seconds * 1000);
    const iso = date.toISOString().replace("Z", "");
    const time = `${iso}.${String(millis).padStart(3, "0")}Z`;

    if (!videoTracks[filename]) {
      videoTracks[filename] = [];
    }

    videoTracks[filename].push({ lat, lon, time });
  }

  await Promise.all(
    Object.entries(videoTracks).map(async ([filename, trackPoints]) => {
      //const outputFile = filename.replace(".txt", ".gpx");
      const outputFile = inputFile.replace(".txt", ".gpx");

      let gpx = `<?xml version="1.0" encoding="UTF-8"?>\n`;
      gpx += `<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">\n`;
      gpx += `  <metadata>\n`;
      gpx += `    <name>Converted GPS Data for ${filename}</name>\n`;
      gpx += `  </metadata>\n`;
      gpx += `  <trk>\n`;
      gpx += `    <trkseg>\n`;

      for (const p of trackPoints) {
        gpx += `      <trkpt lat="${p.lat}" lon="${p.lon}">\n`;
        gpx += `        <time>${p.time}</time>\n`;
        gpx += `      </trkpt>\n`;
      }

      gpx += `    </trkseg>\n`;
      gpx += `  </trk>\n`;
      gpx += `</gpx>\n`;

      await fs.writeFile(outputFile, gpx, "utf-8");
    }),
  );
};

// Обработка всех txt
const processAllTxtFiles = async (destDir) => {
  const files = await fs.readdir(destDir);
  const fullPaths = files.map((file) => path.join(destDir, file));

  const targets = fullPaths.filter(
    (f) => f.endsWith(".txt") && f !== "GPSData000001.txt",
  );

  await Promise.all(targets.map((file) => convertToGpx(file)));
};

// Удаление txt
const deleteTxtFiles = async (destDir) => {
  const files = await fs.readdir(destDir);
  const fullPaths = files.map((file) => path.join(destDir, file));

  const targets = fullPaths.filter(
    (f) => f.endsWith(".txt") && f !== "GPSData000001.txt",
  );

  await Promise.all(targets.map((file) => fs.unlink(file)));
};

// ✅ Главная функция (await-ready)
export const processAndConvert = async (inputFile) => {
  await processAndSplitGpsData(inputFile, 1.0);

  await processAllTxtFiles(path.dirname(inputFile));
  await deleteTxtFiles(path.dirname(inputFile));
};
