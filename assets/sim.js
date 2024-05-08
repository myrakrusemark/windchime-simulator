// Canvas and Context
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

// Canvas Dimensions
const centerX = canvas.width / 2;
const centerY = canvas.height / 2;

// Sound Generator Variables
const sampleRate = 44100; // Sample rate in Hz
let audioContext = null;
let chimeBuffers = [];

// Chime Options
const scales = {
  cMajorPentatonic: [261.63, 293.66, 329.63, 392.00, 440.00, 523.25],
  cMinorPentatonic: [261.63, 293.66, 311.13, 349.23, 392.00, 466.16],
  cMajorDiatonic: [261.63, 293.66, 329.63, 349.23, 392.00, 440.00, 493.88, 523.25],
  cNaturalMinor: [261.63, 293.66, 311.13, 349.23, 392.00, 415.30, 466.16, 493.88],
  cLydian: [261.63, 293.66, 329.63, 369.99, 392.00, 440.00, 493.88, 523.25],
  cMixolydian: [261.63, 293.66, 329.63, 349.23, 392.00, 440.00, 466.16, 523.25],
  cWholeTone: [261.63, 293.66, 329.63, 369.99, 415.30, 466.16, 523.25],
  cOctaveIntervals: [130.81, 261.63, 523.25, 1046.50],
};
let selectedScale = "cMajorPentatonic";
let frequencies = scales[selectedScale];
let loudness = 0.5;
let chimeAttack = 0.001;
let chimeDecay = 2.0;

// Windchime Physical Properties
const chimes = [];
const chimesAnglesX = new Array(5).fill(0);
const chimesAnglesY = new Array(5).fill(0);
const chimesVelocitiesX = new Array(5).fill(0);
const chimesVelocitiesY = new Array(5).fill(0);
const stringLength = 300;
const centerPieceRadius = 105;
const gravity = 0.0098;
const centerPieceDamping = 0.995;
const chimesDamping = 0.99;
const chimesSpacing = 150;
const chimesRadius = 30;
const transferFactor = 0.1;
const massDifference = 20;
const forceMultiplier = 0.007;

// IRL Weather Variables
let latitude = null;
let longitude = null;
let weatherData = null;
let currentWindSpeed = 0;
let currentWindDirection = 0;
let mappedWindSpeed = 0.5;
let weatherTimer = null;
const weatherUpdateInterval = 15;

// Wind Simulation Variables
let wind = 0.0;
let maxWindSpeed = 100;
let windChangeRange = 0.3;
let baseDelay = 0.2;
let gustiness = 0.3;
let randomInterval = 0;
let lastFeatherTime = 0;
let force = 0;
let windAccelerationX = 0;
let windAccelerationY = 0;
let mappedForce = 0.5;
let simulatedtWindDirection = 0;
let lastWindGraph = "";
const graphLength = 50;

// Windchime Interaction Variables
let centerPieceAngleX = 0;
let centerPieceAngleY = 0;
let centerPieceVelocityX = 0;
let centerPieceVelocityY = 0;
let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let dragStartAngleX = 0;
let dragStartAngleY = 0;
let mouseX = 0;
let mouseY = 0;

// UI Variables
const sideMenuWidth = 300;

audioContext = new (window.AudioContext || window.webkitAudioContext)();

// Event Listeners
document.addEventListener("DOMContentLoaded", function () {
  document.getElementById("startButton").addEventListener("click", startWindChimes);
});

document.getElementById("maxWindSpeedSlider").addEventListener("input", function () {
  maxWindSpeed = parseInt(this.value);
  document.getElementById("maxWindSpeedValue").textContent = maxWindSpeed + " mph";
});

document.getElementById("windChangeRangeSlider").addEventListener("input", function () {
  windChangeRange = parseFloat(this.value);
});

document.getElementById("noOfNotesSlider").addEventListener("input", function () {
  document.getElementById("noOfNotesValue").textContent = this.value + " notes";

  calculateChimes();
  drawWindchime();
});

document.getElementById("chimeScaleSelect").addEventListener("change", function () {
  selectedScale = this.value;
  frequencies = scales[selectedScale];
  if (!frequencies) {
    console.error("Selected scale not found:", selectedScale);
    return;
  }
  loadChimes();
});

document.getElementById("chimeAttackSlider").addEventListener("input", function () {
  chimeAttack = parseFloat(this.value);
  document.getElementById("chimeAttackValue").textContent = chimeAttack + " seconds";
  loadChimes();
});

document.getElementById("chimeDecaySlider").addEventListener("input", function () {
  chimeDecay = parseFloat(this.value);
  document.getElementById("chimeDecayValue").textContent = chimeDecay + " seconds";
  loadChimes();
});

// Mouse listeners
canvas.addEventListener('mousedown', handlePointerStart);
canvas.addEventListener('mousemove', handlePointerMove);
canvas.addEventListener('mouseup', handlePointerEnd);
canvas.addEventListener('touchstart', handlePointerStart);
canvas.addEventListener('touchmove', handlePointerMove);
canvas.addEventListener('touchend', handlePointerEnd);

locationInput.addEventListener("keydown", function(event) {
  if (event.key === "Enter") {
    event.preventDefault(); // Prevent form submission (if applicable)
    startWindChimes(); // Call the startWindChimes function
  }
});

// Location and weather functions
async function getLocation() {
  return new Promise((resolve, reject) => {
    console.log("Getting location from browser...");
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          latitude = position.coords.latitude;
          longitude = position.coords.longitude;
          resolve(position);
        },
        (error) => {
          reject(error);
        }
      );
    } else {
      reject(new Error("Geolocation is not supported by this browser."));
    }
  });
}

async function getCoordinatesFromLocation(locationName) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(locationName)}`;

  try {
    const response = await fetch(url);
    const data = await response.json();
    if (data.length > 0) {
      const { lat, lon } = data[0];
      latitude = lat;
      longitude = lon;
      return true;
    } else {
      console.log("Location not found");
      return false;
    }
  } catch (error) {
    console.log("Error:", error);
    return false;
  }
}

async function getCityFromCoordinates() {
  const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=10`;

  try {
    const response = await fetch(url);
    const data = await response.json();
    if (data.address && data.display_name) {
      return Promise.resolve(data.display_name);
    } else {
      return Promise.reject("City not found");
    }
  } catch (error) {
    console.log("Error:", error);
    return Promise.reject(error);
  }
}

async function getLocationByBrowser() {
  return new Promise((resolve, reject) => {
    getLocation()
      .then(() => {
        if (latitude != null && longitude != null) {
          getCityFromCoordinates()
            .then((cityName) => {
              const locationInput = document.getElementById("locationInput");
              locationInput.value = cityName;
              resolve();
            })
            .catch((error) => {
              console.error("Failed to get city from coordinates:", error);
              reject(error);
            });
        } else {
          console.log("Location not properly set");
          reject(new Error("Location not properly set"));
        }
      })
      .catch((error) => {
        console.error("Failed to get location:", error);
        reject(error);
      });
  });
}

async function getLocationByInput() {
  return new Promise((resolve, reject) => {
    const locationInput = document.getElementById("locationInput");
    const locationName = locationInput.value;

    if (locationName) {
      getCoordinatesFromLocation(locationName)
        .then(() => {
          if (latitude != null && longitude != null) {
            getCityFromCoordinates()
              .then((cityName) => {
                const cityOutput = document.getElementById("cityOutput");
                cityOutput.textContent = `${cityName}`;
                resolve();
              })
              .catch((error) => {
                console.error("Failed to get city from coordinates:", error);
                reject(error);
              });
          } else {
            console.log("Location not properly set");
            reject(new Error("Location not properly set"));
          }
        })
        .catch((error) => {
          console.error("Failed to get coordinates from location:", error);
          reject(error);
        });
    } else {
      reject(new Error("No location name provided"));
    }
  });
}

async function getGridUrl(coordinates) {
  try {
    const response = await fetch(`https://api.weather.gov/points/${coordinates}`);
    if (response.status === 200) {
      const data = await response.json();
      return data.properties.forecastGridData;
    } else {
      console.error("Error connecting to the grid URL API:", response.status);
      return null;
    }
  } catch (error) {
    console.error("Error getting grid URL:", error);
    return null;
  }
}

async function getForecast(gridUrl) {
  try {
    const response = await fetch(`${gridUrl}/forecast`);
    if (response.status === 200) {
      const data = await response.json();
      return data;
    } else {
      console.error("Error getting forecast:", response.status);
      return null;
    }
  } catch (error) {
    console.error("Error getting forecast:", error);
    return null;
  }
}

function windDirectionToDegrees(direction) {
  const dirMap = {
      'N': 0,
      'NNE': 22.5,
      'NE': 45,
      'ENE': 67.5,
      'E': 90,
      'ESE': 112.5,
      'SE': 135,
      'SSE': 157.5,
      'S': 180,
      'SSW': 202.5,
      'SW': 225,
      'WSW': 247.5,
      'W': 270,
      'WNW': 292.5,
      'NW': 315,
      'NNW': 337.5
  };

  return dirMap[direction] || null; // Returns null if the direction is not in the map
}

function updateWeatherData() {
  return new Promise(async (resolve, reject) => {
    try {
      console.log(`Getting weather data for ${latitude}, ${longitude}...`);

      if (latitude != null && longitude != null) {
        const gridUrl = await getGridUrl([latitude, longitude]);

        if (gridUrl) {
          const forecastData = await getForecast(gridUrl);

          if (forecastData) {
            weatherData = forecastData;

            // Extract the number from the wind speed string
            const windSpeedString = weatherData.properties.periods[0].windSpeed;
            const windSpeedMatch = windSpeedString.match(/\d+/g);
            currentWindSpeed = windSpeedMatch ? parseInt(windSpeedMatch[0]) : 0;

            currentWindCardinalDirection = weatherData.properties.periods[0].windDirection;
            currentWindDirection = windDirectionToDegrees(currentWindCardinalDirection);

            //Set the value on the page
            const windSpeed = document.getElementById("windSpeed");
            windSpeed.classList.remove("hidden");
            windSpeed.textContent = `${currentWindCardinalDirection} - ${windSpeedString}`;

            resolve();
          } else {
            console.log("Weather: There was an error and the forecast could not be retrieved for the location.");
            reject();
          }
        } else {
          console.log("Weather: There was an error retrieving the right location. Please wait five minutes and try again.");
          reject();
        }
      } else {
        console.log("Weather: There was an error retrieving the coordinates for the zip code.");
        reject();
      }
    } catch (error) {
      console.log(`Weather: Couldn't get weather.`);
      reject(error);
    }
  });
}



// Sound Functions
function playChime(frequency) {
  const sampleCount = Math.floor(sampleRate * (chimeAttack + chimeDecay));
  const t = new Float32Array(sampleCount);

  // Time array
  for (let i = 0; i < sampleCount; i++) {
    t[i] = i / sampleRate;
  }

  // Envelope with exponential decay
  const envelope = new Float32Array(sampleCount);
  const attackDuration = Math.floor(chimeAttack * sampleRate);
  const decayDuration = Math.floor(chimeDecay * sampleRate);

  // Attack phase
  for (let i = 0; i < attackDuration; i++) {
    envelope[i] = i / attackDuration;
  }

  // Decay phase - exponential decay
  const decayFactor = -5 / decayDuration;
  for (let i = attackDuration; i < sampleCount; i++) {
    const decayIndex = i - attackDuration;
    if (decayIndex < decayDuration) {
      envelope[i] = Math.exp(decayFactor * decayIndex);
    } else {
      envelope[i] = envelope[attackDuration + decayDuration - 1] * Math.exp(decayFactor * (decayIndex - decayDuration));
    }
  }

  // Generate chime sound with harmonics
  const chime = new Float32Array(sampleCount);
  const numHarmonics = 3;
  const harmonicStrength = 0.9;

  for (let i = 0; i < sampleCount; i++) {
    let sum = 0;
    for (let h = 1; h <= numHarmonics; h++) {
      sum += (harmonicStrength / h) * Math.sin(2 * Math.PI * frequency * h * t[i]);
    }
    chime[i] = envelope[i] * (Math.sin(2 * Math.PI * frequency * t[i]) + sum);
  }

  return chime;
}

function loadChimes() {
  console.log("Loading chimes (" + selectedScale + ")...");
  chimeBuffers = frequencies.map((frequency) => {
    const chime = playChime(frequency, chimeAttack + chimeDecay);
    const buffer = audioContext.createBuffer(1, chime.length, sampleRate);
    buffer.getChannelData(0).set(chime);
    return buffer;
  });
}

function playChimeSound(index, intensity) {
  const currentTime = Date.now();
  if (currentTime - chimes[index].lastPlayedTime >= 200) { // 200ms = 0.2 seconds
    const source = audioContext.createBufferSource();
    source.buffer = chimeBuffers[index];

    // Create a gain node to control the volume
    const gainNode = audioContext.createGain();
    gainNode.gain.value = intensity;

    // Connect the source to the gain node and then to the destination
    source.connect(gainNode);
    gainNode.connect(audioContext.destination);

    source.start();

    chimes[index].lastPlayedTime = currentTime; // Update the lastPlayedTime
  }
}

// Drawing
function calculateChimes() {
  // Clear the chimes array
  chimes.length = 0;

  // Calculate the positions of the chimes
  const noOfNotes = Math.min(parseInt(document.getElementById("noOfNotesSlider").value), frequencies.length);
  for (let i = 0; i < noOfNotes; i++) {
    const angle = (i * 2 * Math.PI) / noOfNotes;
    const x = centerX + Math.cos(angle) * chimesSpacing;
    const y = centerY + Math.sin(angle) * chimesSpacing;
    chimes.push({ x, y, color: '#ffffff44', lastPlayedTime: 0 }); // Add lastPlayedTime property
  }

  // Resize the chimesAnglesX, chimesAnglesY, chimesVelocitiesX, and chimesVelocitiesY arrays
  chimesAnglesX.length = noOfNotes;
  chimesAnglesY.length = noOfNotes;
  chimesVelocitiesX.length = noOfNotes;
  chimesVelocitiesY.length = noOfNotes;

  // Fill the resized arrays with initial values
  chimesAnglesX.fill(0);
  chimesAnglesY.fill(0);
  chimesVelocitiesX.fill(0);
  chimesVelocitiesY.fill(0);
}

function drawWindchime() {
  const centerPieceX = centerX + Math.sin(centerPieceAngleX) * stringLength;
  const centerPieceY = centerY + Math.sin(centerPieceAngleY) * stringLength;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Draw the center point
  ctx.beginPath();
  ctx.arc(centerX, centerY, 5, 0, 2 * Math.PI);
  ctx.fillStyle = '#ffffff66';
  ctx.fill();

  // Draw the chimes
  chimes.forEach((chime, index) => {
    const chimeX = chime.x + Math.sin(chimesAnglesX[index]) * chimesSpacing;
    const chimeY = chime.y + Math.sin(chimesAnglesY[index]) * chimesSpacing;

    ctx.beginPath();
    ctx.arc(chimeX, chimeY, chimesRadius, 0, 2 * Math.PI);
    ctx.fillStyle = chime.color; // Use the chime's color property
    ctx.fill();
  });

  // Draw the string
  ctx.beginPath();
  ctx.moveTo(centerX, centerY);
  ctx.lineTo(centerPieceX, centerPieceY);
  ctx.strokeStyle = '#ffffff66';
  ctx.stroke();


  // Draw the center piece
  ctx.beginPath();
  ctx.arc(centerPieceX, centerPieceY, centerPieceRadius, 0, 2 * Math.PI);
  ctx.fillStyle = '#ffffff44';
  ctx.fill();

  // Draw the hover effect if the mouse is over the center piece
  if (isMouseOverCenterPiece()) {
    ctx.beginPath();
    ctx.arc(centerPieceX, centerPieceY, centerPieceRadius + 5, 0, 2 * Math.PI);
    ctx.strokeStyle = '#ffffff66';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function isMouseOverCenterPiece() {
  if (mouseX && mouseY) {
    const centerPieceX = centerX + Math.sin(centerPieceAngleX) * stringLength;
    const centerPieceY = centerY + Math.sin(centerPieceAngleY) * stringLength;
    const dx = mouseX - centerPieceX;
    const dy = mouseY - centerPieceY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    return distance < centerPieceRadius;
  }
  return false;
}

function updateChimeColor(index) {
  chimes[index].color = '#ffffff';
  chimes[index].collisionTime = Date.now();
}

function fadeChime(chime) {
  // Fade the chime color back to its original color over 2 seconds
  if (chime.color !== '#ffffff44') {
    const fadeProgress = (Date.now() - chime.collisionTime) / 2000; // 2000ms = 2 seconds
    if (fadeProgress >= 1) {
      chime.color = '#ffffff44';
    } else {
      const opacity = Math.floor(0x44 + (0xff - 0x44) * (1 - fadeProgress));
      chime.color = `#ffffff${opacity.toString(16).padStart(2, '0')}`;
    }
  }
}

function updateWindchime() {
  centerPieceVelocityX += windAccelerationX;
  centerPieceVelocityY += windAccelerationY;

  const centerPieceX = centerX + Math.sin(centerPieceAngleX) * stringLength;
  const centerPieceY = centerY + Math.sin(centerPieceAngleY) * stringLength;
  const centerPieceAccelerationX = -gravity * Math.sin(centerPieceAngleX);
  const centerPieceAccelerationY = -gravity * Math.sin(centerPieceAngleY);

  // Check for collision with the chimes only if the center piece is not being dragged
  if (!isDragging) {
    centerPieceVelocityX += centerPieceAccelerationX;
    centerPieceVelocityY += centerPieceAccelerationY;
    centerPieceAngleX += centerPieceVelocityX;
    centerPieceAngleY += centerPieceVelocityY;
    centerPieceVelocityX *= centerPieceDamping;
    centerPieceVelocityY *= centerPieceDamping;

    chimes.forEach((chime, index) => {
      const chimeX = chime.x + Math.sin(chimesAnglesX[index]) * chimesSpacing;
      const chimeY = chime.y + Math.sin(chimesAnglesY[index]) * chimesSpacing;

      const dx = centerPieceX - chimeX;
      const dy = centerPieceY - chimeY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const minDistance = centerPieceRadius + chimesRadius;

      if (distance < minDistance) {


        // Collision detected with a chime
        const angle = Math.atan2(dy, dx);
        const overlapDistance = minDistance - distance;

        // Move the chimes apart to avoid overlapping
        const overlapX = Math.cos(angle) * overlapDistance;
        const overlapY = Math.sin(angle) * overlapDistance;
        centerPieceAngleX += overlapX / stringLength;
        centerPieceAngleY += overlapY / stringLength;

        // Transfer a portion of the momentum to the chime based on the transfer factor
        chimesVelocitiesX[index] += centerPieceVelocityX * transferFactor * massDifference;
        chimesVelocitiesY[index] += centerPieceVelocityY * transferFactor * massDifference;

        const intensity = Math.sqrt(centerPieceVelocityX ** 2 * centerPieceVelocityY ** 2) * 1000000; // 0 - 1200
        const mappedIntensity = Math.min(intensity / 1200, 1);

        // Reduce the center piece's velocity based on the transfer factor
        centerPieceVelocityX *= (1 - transferFactor);
        centerPieceVelocityY *= (1 - transferFactor);

        updateChimeColor(index);
        playChimeSound(index, mappedIntensity);
      }
    });
  }

  // Update the angles and velocities of the chimes
  chimes.forEach((chime, index) => {
    const chimeAccelerationX = -gravity * Math.sin(chimesAnglesX[index]);
    const chimeAccelerationY = -gravity * Math.sin(chimesAnglesY[index]);
    chimesVelocitiesX[index] += chimeAccelerationX;
    chimesVelocitiesY[index] += chimeAccelerationY;
    chimesAnglesX[index] += chimesVelocitiesX[index];
    chimesAnglesY[index] += chimesVelocitiesY[index];
    chimesVelocitiesX[index] *= chimesDamping;
    chimesVelocitiesY[index] *= chimesDamping;

    // Check for collision with the center piece
    const chimeX = chime.x + Math.sin(chimesAnglesX[index]) * chimesSpacing;
    const chimeY = chime.y + Math.sin(chimesAnglesY[index]) * chimesSpacing;
    const centerPieceX = centerX + Math.sin(centerPieceAngleX) * stringLength;
    const centerPieceY = centerY + Math.sin(centerPieceAngleY) * stringLength;

    const dx = centerPieceX - chimeX;
    const dy = centerPieceY - chimeY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const minDistance = centerPieceRadius + chimesRadius;

    if (distance < minDistance) {
      // Collision detected with the center piece
      const angle = Math.atan2(dy, dx);
      const overlapDistance = minDistance - distance;

      // Move the chime away from the center piece
      const overlapX = Math.cos(angle) * overlapDistance;
      const overlapY = Math.sin(angle) * overlapDistance;
      chimesAnglesX[index] -= overlapX / chimesSpacing;
      chimesAnglesY[index] -= overlapY / chimesSpacing;

      // Reverse the velocity of the chime
      chimesVelocitiesX[index] *= -1;
      chimesVelocitiesY[index] *= -1;
    }

  });

  // Limit the angles of the center piece to prevent it from going off-screen
  const maxAngle = Math.PI / 4; // Adjust the maximum angle as needed
  centerPieceAngleX = Math.max(Math.min(centerPieceAngleX, maxAngle), -maxAngle);
  centerPieceAngleY = Math.max(Math.min(centerPieceAngleY, maxAngle), -maxAngle);

}

// Pointer functions
function handlePointerStart(event) {
  event.preventDefault();
  const pointer = event.touches ? event.touches[0] : event;
  const centerPieceX = centerX + Math.sin(centerPieceAngleX) * stringLength;
  const centerPieceY = centerY + Math.sin(centerPieceAngleY) * stringLength;
  
  const sliderMenu = document.getElementById('sliderMenu');
  const isMenuVisible = sliderMenu.classList.contains('visible');
  const offsetX = isMenuVisible ? sideMenuWidth : 0;
  
  const pointerX = pointer.clientX - canvas.offsetLeft + offsetX;
  const pointerY = pointer.clientY - canvas.offsetTop;
  const dx = pointerX - centerPieceX;
  const dy = pointerY - centerPieceY;
  const distance = Math.sqrt(dx * dx + dy * dy);

  if (distance < centerPieceRadius) {
    isDragging = true;
    dragStartX = pointerX;
    dragStartY = pointerY;
    centerPieceVelocityX = 0;
    centerPieceVelocityY = 0;
  }
}



function handlePointerMove(event) {
  event.preventDefault();
  const pointer = event.touches ? event.touches[0] : event;
  
  const sliderMenu = document.getElementById('sliderMenu');
  const isMenuVisible = sliderMenu.classList.contains('visible');
  const offsetX = isMenuVisible ? sideMenuWidth : 0;
  
  const pointerX = pointer.clientX - canvas.offsetLeft + offsetX;
  const pointerY = pointer.clientY - canvas.offsetTop;
  mouseX = pointerX; // Update mouseX
  mouseY = pointerY; // Update mouseY
  const centerPieceX = centerX + Math.sin(centerPieceAngleX) * stringLength;
  const centerPieceY = centerY + Math.sin(centerPieceAngleY) * stringLength;
  const dx = pointerX - centerPieceX;
  const dy = pointerY - centerPieceY;
  const distance = Math.sqrt(dx * dx + dy * dy);

  if (distance < centerPieceRadius) {
    canvas.style.cursor = 'grab';
  } else {
    canvas.style.cursor = 'default';
  }

  if (isDragging) {

    const pointer = event.touches ? event.touches[0] : event;
    
    const sliderMenu = document.getElementById('sliderMenu');
    const isMenuVisible = sliderMenu.classList.contains('visible');
    const offsetX = isMenuVisible ? sideMenuWidth : 0;
    
    const pointerX = pointer.clientX - canvas.offsetLeft + offsetX;
    const pointerY = pointer.clientY - canvas.offsetTop;
    const dx = pointerX - centerX;
    const dy = pointerY - centerY;
    const newAngleX = Math.asin(dx / stringLength);
    const newAngleY = Math.asin(dy / stringLength);

    // Calculate the velocity of the center piece based on the pointer movement
    const velocityX = (pointerX - dragStartX) * 0.001; // Adjust the multiplier to control the velocity
    const velocityY = (pointerY - dragStartY) * 0.001;

    // Update the angles
    centerPieceAngleX = newAngleX;
    centerPieceAngleY = newAngleY;

    // Check for collision with the chimes
    const centerPieceX = centerX + Math.sin(centerPieceAngleX) * stringLength;
    const centerPieceY = centerY + Math.sin(centerPieceAngleY) * stringLength;

    chimes.forEach((chime, index) => {
      const chimeX = chime.x + Math.sin(chimesAnglesX[index]) * chimesSpacing;
      const chimeY = chime.y + Math.sin(chimesAnglesY[index]) * chimesSpacing;

      const dx = centerPieceX - chimeX;
      const dy = centerPieceY - chimeY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const minDistance = centerPieceRadius + chimesRadius;

      if (distance < minDistance) {
        // Collision detected with a chime
        const angle = Math.atan2(dy, dx);
        const overlapDistance = minDistance - distance;

        // Move the chime away from the center piece
        const overlapX = Math.cos(angle) * overlapDistance;
        const overlapY = Math.sin(angle) * overlapDistance;
        chimesAnglesX[index] -= overlapX / chimesSpacing;
        chimesAnglesY[index] -= overlapY / chimesSpacing;

        // Update the velocities of the chime based on the collision
        chimesVelocitiesX[index] += velocityX * transferFactor * massDifference;
        chimesVelocitiesY[index] += velocityY * transferFactor * massDifference;

        // Calculate the intensity based on the velocity of the center piece
        const intensity = Math.sqrt(velocityX ** 2 + velocityY ** 2) * 10000; // Adjust the multiplier as needed
        const mappedIntensity = Math.min(intensity / 1200, 1);

        updateChimeColor(index);
        playChimeSound(index, mappedIntensity);
      }
    });


    // Update the drag start position
    dragStartX = pointerX;
    dragStartY = pointerY;
  }
}

function handlePointerEnd(event) {
  event.preventDefault();
  if (isDragging) {
    isDragging = false;
    const pointer = event.changedTouches ? event.changedTouches[0] : event;
    
    const sliderMenu = document.getElementById('sliderMenu');
    const isMenuVisible = sliderMenu.classList.contains('visible');
    const offsetX = isMenuVisible ? sideMenuWidth : 0;
    
    const pointerX = pointer.clientX - canvas.offsetLeft + offsetX;
    const pointerY = pointer.clientY - canvas.offsetTop;
    const dx = pointerX - dragStartX;
    const dy = pointerY - dragStartY;
    centerPieceVelocityX = dx * 0.01;
    centerPieceVelocityY = dy * 0.01;
  }
}

// Simulation Functions
function updateFeather() {
  mappedForce = currentWindSpeed / maxWindSpeed;

  const range = [windChangeRange * -2, windChangeRange];
  const windChange = range[0] + Math.random() * (range[1] - range[0]) - gustiness * (1 - mappedForce);

  
  force = Math.max(0, Math.min(force + windChange, mappedForce));


  if (force === 0) {
    const directionRange = [-30, 30];
    const directionChange = directionRange[0] + Math.random() * (directionRange[1] - directionRange[0]);
    simulatedtWindDirection = (currentWindDirection + directionChange + 360) % 360;
  }
}

function featherLoop(currentTime) {
  if (currentTime - lastFeatherTime >= randomInterval) {
    randomInterval = Math.random() * baseDelay * 1000;
    lastFeatherTime = currentTime;

    updateFeather();

    // Inject acceleration into the velocities based on wind speed and direction
    const windAngle = (simulatedtWindDirection * Math.PI) / 180; // Convert degrees to radians
    windAccelerationX = Math.cos(windAngle) * force * forceMultiplier; // Adjust the multiplier as needed
    windAccelerationY = Math.sin(windAngle) * force * forceMultiplier;

    // Output Status
    let windPos = Math.floor(force * graphLength);
    windPos = Math.min(windPos, graphLength);
    let windGraph = "[" + "=".repeat(windPos) + " ".repeat(Math.max(0, graphLength - windPos)) + "]";

    // Only output the status if windGraph has changed
    if (windGraph !== lastWindGraph) {
      const statusOutput = `${windGraph}`;
      console.log(statusOutput);
      lastWindGraph = windGraph;
    }
  }

  requestAnimationFrame(featherLoop);
}

// Start Functions
async function startWindChimes() {
  const locationInput = document.getElementById("locationInput");
  const locationName = locationInput.value;

  clearInterval(weatherTimer);

  if (locationName) {
    const locationFound = await getCoordinatesFromLocation(locationName);
    if (locationFound) {
      await getCityFromCoordinates().then((cityName) => {
        const locationInput = document.getElementById("locationInput");
        locationInput.value = cityName;
      });
      
      updateWeatherData()
        .then(() => {
          // Set the maxWindSpeed slider to 2x the windspeed
          const maxWindSpeedSlider = document.getElementById("maxWindSpeedSlider");
          const maxWindSpeedValue = currentWindSpeed * 2;
          maxWindSpeedSlider.value = maxWindSpeedValue;
          maxWindSpeed = maxWindSpeedValue;
          document.getElementById("maxWindSpeedValue").textContent = maxWindSpeedValue + " mph";

          // Start the featherLoop and animation
          requestAnimationFrame(featherLoop);
        })
        .catch((error) => {
          console.error("Error updating weather data:", error);
        });
    } else {
      const useBrowserLocation = confirm(
        "The entered location could not be found. Would you like to use your current location instead?"
      );
      if (useBrowserLocation) {
        getLocationByBrowser().then(() => {
          updateWeatherData()
            .then(() => {
              // Set the maxWindSpeed slider to 2x the windspeed
              const maxWindSpeedSlider = document.getElementById("maxWindSpeedSlider");
              const maxWindSpeedValue = currentWindSpeed * 2;
              maxWindSpeedSlider.value = maxWindSpeedValue;
              maxWindSpeed = maxWindSpeedValue;
              document.getElementById("maxWindSpeedValue").textContent = maxWindSpeedValue + " mph";

              // Start the featherLoop and animation
              requestAnimationFrame(featherLoop);
            })
            .catch((error) => {
              console.error("Error updating weather data:", error);
            });
        });
      }
    }
  } else {
    getLocationByBrowser().then(() => {
      loadChimes();
      updateWeatherData()
        .then(() => {
          // Set the maxWindSpeed slider to 2x the windspeed
          const maxWindSpeedSlider = document.getElementById("maxWindSpeedSlider");
          const maxWindSpeedValue = currentWindSpeed * 2;
          maxWindSpeedSlider.value = maxWindSpeedValue;
          maxWindSpeed = maxWindSpeedValue;
          document.getElementById("maxWindSpeedValue").textContent = maxWindSpeedValue + " mph";

          // Start the featherLoop and animation
          requestAnimationFrame(featherLoop);
        })
        .catch((error) => {
          console.error("Error updating weather data:", error);
        });
    });
  }

  // Start updating weather data periodically
  weatherTimer = setInterval(updateWeatherData, weatherUpdateInterval * 1000);
}



// Start
function animate() {
  updateWindchime();
  drawWindchime();

  // Constantly fade the chimes back to their original color
  chimes.forEach((chime) => {
    fadeChime(chime);
  });

  requestAnimationFrame(animate);
}

loadChimes();
calculateChimes();
animate();


