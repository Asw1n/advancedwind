const API_BASE_URL = "/plugins/advancedwind"; // Adjust based on your server configuration

let updateInterval = 1000;
let updateTimer;
let updatesPaused = false;

async function getFromServer(endpoint) {
  try {
    const response = await fetch(`${API_BASE_URL}/${endpoint}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Error fetching data: ${response.statusText}`);
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error("Failed to fetch data from server:", error);
    return null;
  }
}

function updateMetadata(data) {
  document.getElementById('timestamp').textContent = data.timestamp;
}

function updateOptions(data) {
  const optionsContent = document.getElementById('options-content');
  optionsContent.innerHTML = ''; // Clear previous content

  const table = document.createElement('table');
  const headerRow = document.createElement('tr');
  headerRow.innerHTML = '<th>Option Name</th><th>Value</th>';
  table.appendChild(headerRow);

  Object.entries(data.options).forEach(([key, value]) => {
    const row = document.createElement('tr');
    row.innerHTML = `<td>${key}</td><td>${value}</td>`;
    table.appendChild(row);
  });

  optionsContent.appendChild(table);
}

function updateWind(data) {
  const stepsList = document.getElementById('steps-list');
  stepsList.innerHTML = ''; // Clear previous steps

  const table = document.createElement('table');
  const headerRow = document.createElement('tr');
  headerRow.innerHTML = '<th>Label</th><th>Speed (knot)</th><th>Angle (°)</th>';
  table.appendChild(headerRow);

  data.windSteps.forEach(step => {
    const row = document.createElement('tr');
    row.innerHTML = `<td>${step.label}</td><td>${step.speed.toFixed(1)}</td><td>${step.angle.toFixed(0)}</td>`;
    table.appendChild(row);
  });

  stepsList.appendChild(table);
}

function updateSpeed(data) {
  const stepsList = document.getElementById('speeds-container');
  stepsList.innerHTML = ''; // Clear previous steps

  const table = document.createElement('table');
  const headerRow = document.createElement('tr');
  headerRow.innerHTML = '<th>Label</th><th>Speed (knot)</th><th>Angle (°)</th>';
  table.appendChild(headerRow);

  data.boatSteps.forEach(step => {
    const row = document.createElement('tr');
    row.innerHTML = `<td>${step.label}</td><td>${step.speed.toFixed(1)}</td><td>${step.angle.toFixed(0)}</td>`;
    table.appendChild(row);
  });

  stepsList.appendChild(table);
}

function updateDelta(data) {
  const stepsList = document.getElementById('delta-container');
  stepsList.innerHTML = ''; // Clear previous steps

  const table = document.createElement('table');
  const headerRow = document.createElement('tr');
  headerRow.innerHTML = '<th>Label</th><th>Delta (°)</th>';
  table.appendChild(headerRow);

  data.deltas.forEach(step => {
    const row = document.createElement('tr');
    row.innerHTML = `<td>${step.label}</td><td>${step.value.toFixed(0)}</td>`;
    table.appendChild(row);
  });

  stepsList.appendChild(table);
}

function updateAttitude(data) {
  const attitudeContainer = document.getElementById('attitude-container');
  attitudeContainer.innerHTML = '';
  const table = document.createElement('table');
  const headerRow = document.createElement('tr');
  headerRow.innerHTML = '<th>Label</th><th>roll</th><th>pitch</th>';
  table.appendChild(headerRow);


  data.attitudeSteps.forEach(step => {
    const row = document.createElement('tr');
    row.innerHTML = `<td>${step.label}</td><td>${step.roll.toFixed(2)}</td><td>${step.pitch.toFixed(2)}</td>`;
    table.appendChild(row);
  });
  attitudeContainer.appendChild(table);
}

async function fetchAndUpdateData() {
  const data = await getFromServer('getResults'); // Updated endpoint
  if (data) {

    updateMetadata(data);
    updateOptions(data);
    updateWind(data);
    updateSpeed(data);
    updateAttitude(data);
    updateDelta(data);
  }
}

function startUpdates() {
  if (updateTimer) clearInterval(updateTimer);
  updateTimer = setInterval(fetchAndUpdateData, updateInterval);
}

function toggleUpdates() {
  updatesPaused = !updatesPaused;
  const toggleButton = document.getElementById('toggle-updates');

  if (updatesPaused) {
    clearInterval(updateTimer);
    toggleButton.textContent = "Resume Updates";
  } else {
    toggleButton.textContent = "Pause Updates";
    startUpdates();
  }
}

document.getElementById('update-interval').addEventListener('input', (event) => {
  updateInterval = parseInt(event.target.value, 10) || 1000;
  if (!updatesPaused) startUpdates();
});

document.getElementById('toggle-updates').addEventListener('click', toggleUpdates);


// Start of SVG functions

async function fetchVectorData() {
  // Replace with your actual backend endpoint
  const data = await getFromServer('getVectors'); // Updated endpoint
  if (data) {
    console.log(data);
    const svg = document.getElementById("canvas");
    svg.innerHTML = ""; // Clear the SVG before redrawing

    const { heading, vectors } = data;

    // Draw Boat
    const boatGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
    boatGroup.setAttribute("transform", `scale(0.4) rotate(${heading})`);
    const boatPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    boatPath.setAttribute("d", "M-50,100 Q-60,20 -40,-40 Q0,-200 40,-40 Q60,20 50,100 Z");
    boatPath.setAttribute("fill", "none");
    boatPath.setAttribute("stroke", "black");
    boatPath.setAttribute("stroke-width", "2");
    boatGroup.appendChild(boatPath);
    svg.appendChild(boatGroup);
    let largest = 0;

    // Draw Vectors
    vectors.forEach(({ label, color, scale, x, y }) => {
      // Draw vector line
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", 0);
      line.setAttribute("y1", 0);
      line.setAttribute("x2", x * scale / scaleToCanvas);
      line.setAttribute("y2", -y * scale / scaleToCanvas);
      line.setAttribute("stroke", color);
      line.setAttribute("stroke-width", "2");
      svg.appendChild(line);
      largest = Math.max(largest, Math.abs(x * scale));
      largest = Math.max(largest, Math.abs(y * scale));


      // Draw vector label
      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("x", x / scaleToCanvas);
      text.setAttribute("y", -y / scaleToCanvas - 5);
      text.setAttribute("class", "label");
      text.setAttribute("fill", color);
      text.textContent = label;
      svg.appendChild(text);
    });
    ns = largest / 160;
    if (scaleToCanvas == 0)
      scaleToCanvas = ns;
    else
      scaleToCanvas -= (scaleToCanvas - ns) * .01;

  }
}



// Initial Draw and Set Interval for Updates
let scaleToCanvas = 0; // Scaling factor for vector length

setInterval(fetchVectorData, 100); // Update every second






// Initial fetch and start updates
fetchAndUpdateData();
startUpdates();
