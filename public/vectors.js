const API_BASE_URL = "/plugins/advancedwind";
let previous = 0;
let lastTime = new Date();

function getHeading(data) {
  let heading = 0;
  data.deltas.forEach(delta => {
    if (delta.id == "heading") {
      heading = delta.value * 180 / Math.PI;
    }
  });
  return heading;
}

function getOffset(data) {
  let offset = { x: 0, y: 0 };
  data.deltas.forEach(delta => {
    if (delta.id == "attitude") {
      offset.x = Math.sin(delta.value.pitch) * 30;
      offset.y = Math.sin(delta.value.roll) * 30;
      console.log(delta.value);
      console.log(offset);
    }
  });
  return offset;
}

function getLargest(data) {
  let largest = 1;
  data.polars.forEach(polar => {
    if (polar.id != "sensorSpeed")
    largest = Math.max(largest, polar.speed);
  });
  return largest;
}

function drawBoat(canvas, data, heading, offset) {


  const hull = document.createElementNS("http://www.w3.org/2000/svg", "path");
  hull.setAttribute("d", "M -45 8  Q 15 20 30 0 Q 15 -20 -45 -8 z");
  hull.setAttribute("fill", "none");
  hull.setAttribute("stroke", "black");
  hull.setAttribute("stroke-width", "1");
  //hull.setAttribute("transform", `scale(1, ${1 - Math.sin(roll)})`);
  hull.setAttribute("id", "hull");

  const mast = document.createElementNS("http://www.w3.org/2000/svg", "line");
  mast.setAttribute("x1", 0);
  mast.setAttribute("y1", 0);
  mast.setAttribute("x2", offset.x);
  mast.setAttribute("y2", offset.y);
  mast.setAttribute("id", "mast");


  const boat = document.createElementNS("http://www.w3.org/2000/svg", "g");
  boat.setAttribute("transform", `rotate(${heading - 90})`);
  boat.appendChild(hull);
  boat.appendChild(mast);
  canvas.appendChild(boat);
}


function drawVectors(canvas, data, heading, scale) {
  data.polars.forEach(polar => {
    const vector = document.createElementNS("http://www.w3.org/2000/svg", "line");
    vector.setAttribute("x1", 0 + (polar.plane == "ref_mast" ? offset.x : 0));
    vector.setAttribute("y1", 0 + (polar.plane == "ref_mast" ? offset.y : 0));
    vector.setAttribute("x2", polar.speed * Math.cos(polar.angle) * scale + (polar.plane == "ref_mast" ? offset.x : 0));
    vector.setAttribute("y2", polar.speed * Math.sin(polar.angle) * scale + (polar.plane == "ref_mast" ? offset.y : 0));
    vector.setAttribute("id", polar.id);
    if (polar.plane == "ref_ground")
      vector.setAttribute("transform", `rotate(${-90})`);
    else
      vector.setAttribute("transform", `rotate(${heading - 90})`);
    canvas.appendChild(vector);
  });
}

function drawKnots(canvas, largest, scale) {
  let knot = 0;
  let r = 0;
  while (r < largest) {
    knot += 1;
    r = knot / 1.94384;
    radius = r * scale;
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("r", radius);
    circle.setAttribute("class", "knotCircle");
    canvas.appendChild(circle);
  }
}

async function fetchVectorData() {
  const data = await getFromServer('getVectors');
  if (data) {
    const canvas = document.getElementById("canvas");
    canvas.innerHTML = "";

    heading = getHeading(data);
    largest = getLargest(data);
    offset = getOffset(data);
    if (previous == 0) {
      previous = largest;
      lastTime = new Date();
    }
    else {
      time = new Date();
      deltaT = (time - lastTime) ;
      if (largest > previous)
        tc = 1;
      else
        tc = 4;
      const alpha = 1 - Math.exp(-deltaT / tc);
      previous = previous + alpha * (largest - previous);
    }

    scale = 100 / previous;
    drawVectors(canvas, data, heading, scale, offset);
    drawKnots(canvas, largest, scale);
    drawBoat(canvas, data, heading, offset);
  }

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
}

setInterval(fetchVectorData, 200); 
