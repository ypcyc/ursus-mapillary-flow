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
  console.log(`Processing GPS data from: ${inputFile}`);
  const content = await fs.readFile(inputFile, "utf-8");
  const lines = content.split("\n");

  const videoFiles = {};
  const videoPoints = {};

  let linecount = 0;

  for (const line of lines) {
    console.log(`Processing line ${linecount++}: ${line}`);
    if (
      !line ||
      line.includes("$V02") ||
      line.includes("nan") ||
      line.includes("000000000000000000000000000")
    )
      continue;

    const parts = line.trim().split(",");

    let lat, lon, videoName;

    if (parts.length === 8) {
      //Old 70mai format

      // 2026-04-11 12:17:48,
      // B,
      // A,
      // 013km/h,
      // 56.930094,
      // 24.014493,
      // 0,
      // 20260411-131747-013650B.MP4

      lat = Number(parts[4]);
      lon = Number(parts[5]);
      videoName = parts[7]?.trim();

      videoName = videoName.replace("B.MP4", "");
      videoName = videoName.replace("F.MP4", "");

      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      const time = parts[0];
      try {
        const gpxTime = new Date(time.replace(" ", "T") + "Z").toISOString();
      } catch (error) {
        console.error("Error parsing time:", time);
      }

      if (!videoFiles[videoName]) {
        videoFiles[videoName] = { type: "70mai_v1", start: time, end: time };
      } else {
        videoFiles[videoName].end = time;
      }

      lat = parseFloat(parts[4]);
      lon = parseFloat(parts[5]);

      if (!videoPoints[videoName]) {
        videoPoints[videoName] = [];
      }

      videoPoints[videoName].push([lat, lon, time]);
    } else if (parts.length > 10) {
      videoName = parts[9];
      const timestampMs = Math.floor(parseFloat(parts[0]) * 1000);

      if (!videoFiles[videoName]) {
        videoFiles[videoName] = {
          type: "70mai_v2",
          start: timestampMs,
          end: timestampMs,
        };
      } else {
        videoFiles[videoName].end = timestampMs;
      }

      lat = parseFloat(parts[2]);
      lon = parseFloat(parts[3]);

      if (!videoPoints[videoName]) {
        videoPoints[videoName] = [];
      }

      videoPoints[videoName].push([lat, lon, timestampMs]);
    }
  }

  const allLines = [];

  for (const [videoName, points] of Object.entries(videoPoints)) {
    if (videoFiles[videoName].type === "70mai_v1") {
      points.forEach(([lat, lon, time]) => {
        //const timestamp = new Date(time.replace(" ", "T") + "Z").getTime();
        const roundedLat = Number(lat.toFixed(6));
        const roundedLon = Number(lon.toFixed(6));

        allLines.push([time, roundedLat, roundedLon, videoName, "70mai_v1"]);
      });
    } else if (videoFiles[videoName].type === "70mai_v2") {
      const { start, end } = videoFiles[videoName];
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
            allLines.push([
              timestamp,
              roundedLat,
              roundedLon,
              videoName,
              "70mai_v2",
            ]);
          }
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
    if (parts.length !== 5) continue;

    let [timestamp, lat, lon, filename, videoType] = parts;

    let gpxTime;

    if (videoType === "70mai_v1") {
      gpxTime = new Date(timestamp.replace(" ", "T") + "Z").toISOString();
    } else if (videoType === "70mai_v2") {
      timestamp = parseInt(timestamp, 10);

      const seconds = Math.floor(timestamp / 1000);
      const millis = timestamp % 1000;

      const date = new Date(seconds * 1000);
      const iso = date.toISOString().replace("Z", "");
      gpxTime = `${iso}.${String(millis).padStart(3, "0")}Z`;
    }

    if (!videoTracks[filename]) {
      videoTracks[filename] = [];
    }

    videoTracks[filename].push({ lat, lon, gpxTime });
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
        gpx += `        <time>${p.gpxTime}</time>\n`;
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
    (f) => f.endsWith(".txt") && !f.endsWith("GPSData000001.txt"),
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
