const API_BASE_URL = "/plugins/advancedwind";
let previous = 0;
let lastTime = new Date();

function getHeading(data) {
  let heading = 0;
  data.deltas.forEach(delta => {
    if (delta.id == "heading") {
      heading = delta.value * 180 / Math.PI ;
    }
  });
  return heading;
}

function getLargest(data) {
  let largest = 1;
  data.polars.forEach(polar => {
    largest = Math.max(largest, polar.speed);
  });
  return largest;
}

function drawBoat(canvas, data, heading) {

let roll=0;
let pitch =0;

  data.deltas.forEach(delta => {
    if (delta.id == "attitude") {
      pitch = delta.value.pitch;
      roll = delta.value.roll;
    }
  });



  const hull = document.createElementNS("http://www.w3.org/2000/svg", "path");
  hull.setAttribute("d", "M -45 8  Q 15 20 30 0 Q 15 -20 -45 -8 z");
  hull.setAttribute("fill", "none");
  hull.setAttribute("stroke", "black");
  hull.setAttribute("stroke-width", "1");
  hull.setAttribute("transform", `scale(1, ${1 - Math.sin(roll)})`);
  hull.setAttribute("id", "hull");

  const mast = document.createElementNS("http://www.w3.org/2000/svg", "line");
  mast.setAttribute("x1", 0);
  mast.setAttribute("y1", 0);
  mast.setAttribute("x2", Math.sin(pitch) * 30);
  mast.setAttribute("y2", Math.sin(roll) * 30);
  mast.setAttribute("id", "mast");
  

  const boat = document.createElementNS("http://www.w3.org/2000/svg", "g");
  boat.setAttribute("transform", `rotate(${heading-90})`);
  boat.appendChild(hull);
  boat.appendChild(mast);
  canvas.appendChild(boat);
}


function drawVectors(canvas, data, heading, scale) {
  data.polars.forEach(polar => {
    const vector = document.createElementNS("http://www.w3.org/2000/svg", "line");
    vector.setAttribute("x1", 0);
    vector.setAttribute("y1", 0);
    vector.setAttribute("x2", polar.speed * Math.cos(polar.angle) * scale);
    vector.setAttribute("y2", polar.speed * Math.sin(polar.angle) * scale);
    vector.setAttribute("id", polar.id);
    if (polar.plane == "ref_ground") 
      vector.setAttribute("transform", `rotate(${-90})`);
    else
      vector.setAttribute("transform", `rotate(${heading -90})`);
    canvas.appendChild(vector);
  });
}

function drawKnots(canvas, largest, scale) {
    let knot =0;
    let r = 0;
    while (r <largest) {
      knot += 1;
      r = knot / 1.94384;
      radius = r * scale;
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("r", radius);
    circle.setAttribute("class","knotCircle");
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
    if (previous == 0) {
      previous = largest;
      lastTime = new Date();
    }
    else {
      time = new Date();
      deltaT = (time - lastTime) / 1000;
      if (largest > previous) 
        tc = 40;
      else  
        tc=120;
      const alpha = 1 - Math.exp(-deltaT / tc);
      previous =  previous + alpha * (largest -previous);
    }

    scale = 100 / previous;
    drawVectors(canvas, data, heading, scale);
    drawKnots(canvas, largest, scale);
    drawBoat(canvas, data, heading);
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
