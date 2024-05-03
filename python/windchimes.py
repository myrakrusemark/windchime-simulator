import numpy as np
import sounddevice as sd
import random
import threading
import time
from weather import get_weather
from pprint import pprint

# Sound Generator Variables
sample_rate = 44100  # Sample rate in Hz
duration = 3.0  # Duration in seconds
loudness = .5

# chime options
c_major_pentatonic = [261.63, 293.66, 329.63, 392.00, 440.00]
c_minor_pentatonic = [261.63, 293.66, 311.13, 349.23, 392.00]
c_major_diatonic = [261.63, 293.66, 329.63, 349.23, 392.00, 440.00, 493.88]
c_natural_minor = [261.63, 293.66, 311.13, 349.23, 392.00, 415.30, 466.16]
c_lydian = [261.63, 293.66, 329.63, 369.99, 392.00, 440.00, 493.88]
c_mixolydian = [261.63, 293.66, 329.63, 349.23, 392.00, 440.00, 466.16]
c_whole_tone = [261.63, 293.66, 329.63, 369.99, 415.30, 466.16]
c_octave_intervals = [130.81, 261.63, 523.25]

frequencies = c_major_pentatonic

# IRL Weather Variables
zip_code = "63139"
weather_data = None
current_wind_speed = 0
mapped_wind_speed = 0.5
weather_timer = None
wind = 0.0
weather_update_interval = 15

# Wind-related variables

max_wind_speed = 60 # Maximum range for wind speed (mph) 
# A lower value results in louder and more frequent chimes.

wind_change_range = (-0.3, 0.3)  # Range for random changes in wind speed
# A larger range will result in more dramatic changes in wind speed,
# affecting the frequency and spacing of chime sounds.

base_delay = 0.3  # Base delay for chime generation
# A larger base delay will result in longer pauses between chime sounds,
# especially when the wind speed is low.

wind_sleep_factor = 1.0  # Factor for sleep time based on wind speed
# A larger factor will result in longer pauses between wind speed updates,
# leading to more gradual changes in the chime patterns.

chime_wind_speed_cutoff = 0.1 # Wind speed where chimes start (0-1)
# Below this number no chimes are triggered.

mapped_wind_speed_override = None #Use this value to override the weather API (0-1)

lock = threading.Lock()

def update_weather_data():
    try:
        global weather_data, weather_timer, current_wind_speed
        print(f"Getting weather data for {zip_code}...")
        weather_data = get_weather(zip_code)

        # Cancel the existing timer if it exists
        if weather_timer is not None:
            weather_timer.cancel()
            current_wind_speed = int(weather_data["properties"]["periods"][0]["windSpeed"])
            print(f"Current wind speed: {current_wind_speed}")


    except:
        print(f"Couldn't get IRL weather. Using last value: {current_wind_speed}mph")

    # Start a new timer
    weather_timer = threading.Timer(weather_update_interval, update_weather_data)
    weather_timer.daemon = True
    weather_timer.start()
        

def play_chime(frequency, duration=duration):
    t = np.linspace(0, duration, int(sample_rate * duration), endpoint=False)
    envelope = np.concatenate([
        np.linspace(0, 1, int(0.01 * sample_rate)),
        np.exp(-np.linspace(0, 5, int(2.0 * sample_rate))),
        np.zeros(len(t) - int(0.01 * sample_rate) - int(2.0 * sample_rate))
    ])
    chime = envelope * np.sin(2 * np.pi * frequency * t)
    return chime / np.max(np.abs(chime))

# Pre-generate samples for each frequency
samples = {}
print("Generating chimes...")
for frequency in frequencies:
    samples[frequency] = play_chime(frequency)

def stream_callback(outdata, frames, time, status):
    global buffer
    with lock:
        outdata[:] = buffer[:frames]
        buffer = np.concatenate((buffer[frames:], np.zeros((frames, 2))))

buffer = np.zeros((int(sample_rate * duration), 2))

stream = sd.OutputStream(callback=stream_callback, samplerate=sample_rate, channels=2)
stream.start()

def normalize_buffer():
    global buffer
    with lock:
        max_val = np.max(np.abs(buffer))
        if max_val > 1.0:
            buffer /= max_val

def add_chime_to_buffer(frequency, volume):
    global loudness
    min_loudness = 0.01  # Minimum loudness
    max_loudness = 0.7  # Maximum loudness
    exponential_factor = 2  # Adjust this value to control the curve
    loudness = min_loudness + (volume ** exponential_factor) * (max_loudness - min_loudness)
    chime = samples[frequency] * loudness
    with lock:
        buffer[:len(chime)] += chime[:, np.newaxis]
    normalize_buffer()

def update_wind():
    global wind, current_wind_speed, mapped_wind_speed
    wind_change = random.uniform(*wind_change_range)

    if mapped_wind_speed_override:
        mapped_wind_speed = mapped_wind_speed_override
    else:
        mapped_wind_speed = current_wind_speed / max_wind_speed

    wind = max(0, min(wind + wind_change, mapped_wind_speed))

# Start the weather update cycle
update_weather_data()


def play_chimes_loop():
    global wind

    graph_length = 50  # Fixed length of the wind graph
    ascending = random.choice([True, False])  # Flag to determine the direction of chime selection
    chime_index = 0

    while True:
        if mapped_wind_speed > chime_wind_speed_cutoff:
            update_wind()
            random_value = random.random()
            wind_pos = int(wind * graph_length)
            wind_graph = "[" + "≈" * wind_pos + " " * (graph_length - wind_pos) + "]"

            random_pos = int(random_value * graph_length)
            wind_graph = wind_graph[:random_pos] + "|" + wind_graph[random_pos+1:]

            base_delay_chimes = 0

            # Determine the number of chimes to play based on wind speed
            num_chimes = 1
            if wind < 0.3:
                num_chimes = random.randint(1, 2)
            elif wind < 0.6:
                num_chimes = random.randint(1, 3)
            else:
                num_chimes = random.randint(1, 4)

            if random_value < wind:

                # Play the specified number of chimes in sequential order
                for i in range(num_chimes):

                    threading.Timer(base_delay_chimes, lambda idx=chime_index: add_chime_to_buffer(frequencies[idx], random_value)).start()

                    # Update the chime index based on the direction
                    if ascending:
                        if num_chimes > 1 and i < num_chimes and chime_index == len(frequencies) - 1:
                            chime_index = 0
                        elif num_chimes > 1 and i < num_chimes:
                            chime_index = chime_index + 1
                        else:
                            chime_index = random.randint(0, len(frequencies)-1)
                    else:
                        if num_chimes > 1 and i < num_chimes and chime_index == 0:
                            chime_index = len(frequencies) - 1
                        elif num_chimes > 1 and i < num_chimes:
                            chime_index = chime_index - 1
                        else:
                            chime_index = random.randint(0, len(frequencies)-1)

                    # Determine the gap between sequential chimes, based on wind speed and random variation
                    base_delay_chimes = i *  (base_delay * (1 - wind * random.random()))

                    # The first two chimes may vary from 0 to base_delay_chimes, as two chimes may be hit at the same time.
                    if i == 0 and num_chimes > 1:
                        base_delay_chimes = base_delay_chimes * random.random()

            ascending = random.choice([True, False])

            chime_indicator = " * " * num_chimes if random_value < wind else ""
            print(f"{int(current_wind_speed)}mph {wind_graph}{chime_indicator}")
        
        else:

            print(f"{current_wind_speed}mph - Not enough wind")

        time.sleep(wind_sleep_factor * random.random())

play_chimes_loop() 