import requests
import logging
import yaml
import geocoder

class Weather:
    def __init__(self, zip_code):
        self.zip_code = zip_code
        self.location = None
        self.latlon = None
        self.grid_url = None
        self.forecast_data = None

    def get_coordinates(self):
        logging.info("Getting coordinates for zip code: " + self.zip_code)
        try:
            g = geocoder.arcgis(self.zip_code)
            self.latlon = str(g.json['lat']) + "," + str(g.json['lng'])
        except Exception as e:
            logging.error("Error getting coordinates: " + str(e))

    def get_forecast(self):
        """Get the forecast from the grid url"""
        # Get the grid url
        if not self.grid_url:
            self._get_grid_url()

        # Get the forecast from the grid
        if self.grid_url:
            forecast_url = "{}/forecast".format(self.grid_url)
            logging.info("Forecast URL: " + forecast_url)
            response = requests.get(forecast_url)
            if response.json():
                self.forecast_data = response.json()
                return self.forecast_data
            else:
                return "There was an error. Status code: " + str(response.status_code)
        else:
            return None

    def _get_grid_url(self):
        """Get the URL for the grid data for the current latlon."""
        # Get the JSON data for the latlon
        url = f"https://api.weather.gov/points/{self.latlon}"
        logging.info("Grid URL: " + url)
        response = requests.get(url)
        if response.status_code == 200:
            data = response.json()
            # Get the URL for the grid data from the latlon JSON
            self.grid_url = data["properties"]["forecastGridData"]
        else:
            logging.error("Error connecting to the grid url API: " + str(response.status_code) + " " + f"https://api.weather.gov/points/{self.latlon}")
            self.grid_url = None

def get_weather(zip_code):
    weather = Weather(zip_code)
    weather.get_coordinates()
    if weather.latlon:
        forecast = weather.get_forecast()
        if forecast:
            return weather.forecast_data
        else:
            print("Weather forecast: There was an error and the forecast could not be retrieved for the location.")
    else:
        print("Weather forecast: There was an error retrieving the right location. Please wait five minutes and try again.")
    return None

def main():
    zip_code = input("Enter the zip code: ")
    weather = get_weather(zip_code)
    if weather:
        try:
            result = "Weather forecast for " + zip_code + ":\n"
            result += "Current conditions:\n"
            result += "Temperature: " + str(weather["properties"]["periods"][0]["temperature"]) + " " + weather["properties"]["periods"][0]["temperatureUnit"] + "\n"
            result += "Wind: " + weather["properties"]["periods"][0]["windSpeed"] + " " + weather["properties"]["periods"][0]["windDirection"] + "\n"
            result += "Humidity: " + str(weather["properties"]["periods"][0]["relativeHumidity"]['value']) + "%\n"
            result += "Dew Point: " + str(weather["properties"]["periods"][0]["dewpoint"]['value']) + " C\n"
            result += "Wind Direction: " + str(weather["properties"]["periods"][0]["windDirection"]) + "\n"
            result += "Weather: " + weather["properties"]["periods"][0]["shortForecast"] + "\n"
            result += "\nTonight:\n"
            result += "Temperature: " + str(weather["properties"]["periods"][1]["temperature"]) + " " + weather["properties"]["periods"][1]["temperatureUnit"] + "\n"
            result += "Weather: " + weather["properties"]["periods"][1]["shortForecast"] + "\n"
            result += "\nThis week:\n"
            for day in weather["properties"]["periods"][2:7]:
                result += day["name"] + ": " + day["detailedForecast"] + "\n"
            print(result)
        except:
            logging.error("Error getting forecast")
            print("Weather forecast: There was a server issue.")

if __name__ == "__main__":
    main()