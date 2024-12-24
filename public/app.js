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
    console.log(data);
    updateMetadata(data);
    updateOptions(data);
    updateWind(data);
    updateSpeed(data);
    updateAttitude(data);
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

// Initial fetch and start updates
fetchAndUpdateData();
startUpdates();
