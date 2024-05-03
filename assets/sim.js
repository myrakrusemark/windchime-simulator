// Sound Generator Variables
const sampleRate = 44100; // Sample rate in Hz
let loudness = 0.5;
let chimeAttack = 0.001;
let chimeDecay = 2.0;
let audioContext = null;
let chimeBuffers = [];

// Chime options
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

// IRL Weather Variables
let latitude = null;
let longitude = null;
let weatherData = null;
let currentWindSpeed = 0;
let mappedWindSpeed = 0.5;
let weatherTimer = null;
let wind = 0.0;
const weatherUpdateInterval = 15;

// Wind-related variables
let maxWindSpeed = 60;
let windSleepFactor = 1.0;
let windChangeRange = 0.3;
let baseDelay = 0.8;
let chimeWindSpeedCutoff = 0.2;
let multiChime = 0.8;
let noOfNotes = 5;
let loudnessDecay = 0.5;

let loopTimer = null;

// Event Listeners
document.addEventListener("DOMContentLoaded", function () {
  document.getElementById("startButton").addEventListener("click", startWindChimes);
});

// Slider Event Listeners
document.getElementById("maxWindSpeedSlider").addEventListener("input", function () {
  maxWindSpeed = parseInt(this.value);
  document.getElementById("maxWindSpeedValue").textContent = maxWindSpeed + " mph";
  updateChimeWindSpeedCutoffValue();
});

document.getElementById("chimeWindSpeedCutoffSlider").addEventListener("input", function () {
  chimeWindSpeedCutoff = parseFloat(this.value);
  updateChimeWindSpeedCutoffValue();
});

document.getElementById("windSleepFactorSlider").addEventListener("input", function () {
  windSleepFactor = parseFloat(this.value);
});

document.getElementById("windChangeRangeSlider").addEventListener("input", function () {
  windChangeRange = parseFloat(this.value);
});

document.getElementById("baseDelaySlider").addEventListener("input", function () {
  baseDelay = parseFloat(this.value);
  document.getElementById("baseDelayValue").textContent = baseDelay + " seconds";
});

document.getElementById("multiChimeSlider").addEventListener("input", function () {
  multiChime = parseFloat(this.value);
});

document.getElementById("noOfNotesSlider").addEventListener("input", function () {
  noOfNotes = parseFloat(this.value);
  document.getElementById("noOfNotesValue").textContent = noOfNotes + " notes";
});

document.getElementById("loudnessDecaySlider").addEventListener("input", function () {
  loudnessDecay = parseFloat(this.value);
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

// Helper Functions
function updateChimeWindSpeedCutoffValue() {
  const windSpeedCutoff = Math.round(maxWindSpeed * chimeWindSpeedCutoff);
  document.getElementById("chimeWindSpeedCutoffValue").textContent = windSpeedCutoff + " mph";

  const notEnoughWind = document.getElementById("notEnoughWind");
  if (currentWindSpeed / maxWindSpeed < chimeWindSpeedCutoff) {
    notEnoughWind.textContent = `Not enough wind (${windSpeedCutoff} mph)`;
    notEnoughWind.classList.remove("hidden");
  } else {
    notEnoughWind.classList.add("hidden");
  }
}

// Location Functions
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
      console.log(`lat: ${latitude}, lon: ${longitude}`);
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

// Weather Functions
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
            currentWindSpeed = weatherData.properties.periods[0].windSpeed.split(" ")[0];
            const windSpeed = document.getElementById("windSpeed");
            windSpeed.classList.remove("hidden");
            windSpeed.textContent = `${currentWindSpeed} mph`;
            updateChimeWindSpeedCutoffValue();
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

// Wind Functions
function updateWind() {
  const range = [windChangeRange * -1, windChangeRange];
  const windChange = range[0] + Math.random() * (range[1] - range[0]);

  mappedWindSpeed = currentWindSpeed / maxWindSpeed;
  wind = Math.max(0, Math.min(wind + windChange, mappedWindSpeed));
}

// Main Functions
async function startWindChimes() {
  stopLoop(); // Ensure any existing loop is stopped
  audioContext = new (window.AudioContext || window.webkitAudioContext)();

  const locationInput = document.getElementById("locationInput");
  const locationName = locationInput.value;

  if (locationName) {
    const locationFound = await getCoordinatesFromLocation(locationName);
    if (locationFound) {
      await getCityFromCoordinates().then((cityName) => {
        const locationInput = document.getElementById("locationInput");
        locationInput.value = cityName;
      });
      loadChimes();
      updateWeatherData()
        .then(() => {
          playChimesLoop();
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
          loadChimes();
          updateWeatherData()
            .then(() => {
              playChimesLoop();
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
          playChimesLoop();
        })
        .catch((error) => {
          console.error("Error updating weather data:", error);
        });
    });
  }
}

function playChimesLoop() {
  const graphLength = 50; // Fixed length of the wind graph
  let ascending = Math.random() < 0.5; // Flag to determine the direction of chime selection
  let chimeIndex = 0;

  function loop() {
    updateWind();
    if (mappedWindSpeed > chimeWindSpeedCutoff) {
      const randomValue = Math.random();
      let windPos = Math.floor(wind * graphLength);
      windPos = Math.min(windPos, graphLength);
      let windGraph = "[" + "=".repeat(windPos) + " ".repeat(Math.max(0, graphLength - windPos)) + "]";

      const randomPos = Math.floor(randomValue * graphLength);
      windGraph = windGraph.slice(0, randomPos) + "|" + windGraph.slice(randomPos + 1);

      // Determine the number of chimes to play based on wind speed
      let numChimes = 1;
      if (Math.random() < multiChime) {
        if (randomValue < 0.3) {
          numChimes = Math.floor(Math.random() * 2) + 1;
        } else if (randomValue < 0.6) {
          numChimes = Math.floor(Math.random() * 3) + 1;
        } else {
          numChimes = Math.floor(Math.random() * 4) + 1;
        }
      }

      if (randomValue < wind) {
        // Play the specified number of chimes in sequential order
        for (let i = 0; i < numChimes; i++) {
          let baseDelayChimes = baseDelay * (1 - wind);

          // The first two chimes may vary from 0 to baseDelayChimes, as two chimes may be hit at the same time.
          if (i === 0 && numChimes > 1) {
            baseDelayChimes = baseDelayChimes * Math.random();
          }

          setTimeout(() => {
            const source = audioContext.createBufferSource();
            source.buffer = chimeBuffers[chimeIndex];
            const gainNode = audioContext.createGain();
            gainNode.gain.value = randomValue * (1 - i * loudnessDecay);
            source.connect(gainNode);
            gainNode.connect(audioContext.destination);
            source.start();

            // Update the chime index based on the direction
            if (ascending) {
              if (numChimes > 1 && i < numChimes && chimeIndex === Math.min(frequencies.length, noOfNotes) - 1) {
                chimeIndex = 0;
              } else if (numChimes > 1 && i < numChimes) {
                chimeIndex++;
              } else {
                chimeIndex = Math.floor(Math.random() * Math.min(frequencies.length, noOfNotes));
              }
            } else {
              if (numChimes > 1 && i < numChimes && chimeIndex === 0) {
                chimeIndex = Math.min(frequencies.length, noOfNotes) - 1;
              } else if (numChimes > 1 && i < numChimes) {
                chimeIndex--;
              } else {
                chimeIndex = Math.floor(Math.random() * Math.min(frequencies.length, noOfNotes));
              }
            }

            chimeIndex = chimeIndex % Math.min(frequencies.length, noOfNotes); // Ensure index does not exceed the number of accessible notes
          }, (i === 1 && numChimes > 1 ? i * baseDelayChimes * Math.random() : i * baseDelayChimes) * 1000);
        }
      }

      ascending = Math.random() < 0.5;

      const chimeIndicator = randomValue < wind ? " * ".repeat(numChimes) : "";
      const statusOutput = `${Math.floor(currentWindSpeed)}mph ${windGraph}${chimeIndicator}`;
      console.log(statusOutput);
    } else {
      console.log(`${currentWindSpeed}mph - Not enough wind`);
    }

    loopTimer = setTimeout(loop, windSleepFactor * Math.random() * 1000);
  }

  loop();
}

function stopLoop() {
  if (loopTimer) {
    clearTimeout(loopTimer); // Stop the current loop
    loopTimer = null; // Reset the timer reference
  }
}