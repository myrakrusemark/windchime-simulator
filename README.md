# Wind Chime Simulator

A wind chime hanging in a browser tab. Open the page and it is already there and already
swinging: a plate, a set of tuned tubes, a clapper on a cord and a sail for the wind to
push, solved as constrained particles and voiced by modal synthesis. There is no form to
fill in and nothing to start.

![Wind Chime Simulator Screenshot](assets/screen.png)

## Features

- A finished chime on the first frame, hanging in a place, with no setup
- Tubes, striker, sail and hanging point, each changeable while the chime keeps ringing
- Modal synthesis of struck aluminium, so a wider tube really does come out darker
- Live weather from api.weather.gov, optional, one panel in
- Every chime is a link, and the link carries the whole design

## How to Use

1. Open it. A chime is hanging there, swinging in the wind that place has.
2. Click anywhere for sound. Browsers refuse to start audio until a gesture arrives, so
   that one click is the floor and there is nothing under it.
3. Press a pill along the bottom (Place, Tubes, Striker, Sail, Hang) to open that part.
   Anything you move takes effect on the chime as you move it.
4. Press Share. What lands on your clipboard reopens the same chime, in the same place.
5. For real weather, open Place, type a town and press "Use live weather". Nothing on the
   first frame reaches the network, and nothing asks the browser where you are unless you
   ask for a location by name.

## Technologies Used

- HTML5
- CSS3
- JavaScript
- Web Audio API
- three.js r185, vendored
- api.weather.gov, the National Weather Service forecast API

## File Structure

- `index.html`: The main HTML file that structures the web page.
- `assets/styles.css`: The CSS file that defines the styles for the web page.
- `assets/js/wind.js`: The wind field. Mean, gust and turbulence, sampled by everything that moves.
- `assets/js/physics.js`: The rig. Plate, tubes, clapper and sail as a constrained particle assembly.
- `assets/js/scene.js`: The picture. Renderer, camera, sky, light, chime meshes and cords.
- `assets/js/windviz.js`: The visible wind. Grass, airborne streaks, leaves and the telltale ribbon.
- `assets/js/audio.js`: Modal synthesis of a struck aluminium tube, driven by strike events.
- `assets/js/weather.js`: Geocoding and the api.weather.gov forecast, with every failure path returning null.
- `assets/js/main.js`: The wiring, the controls and the animation loop.
- `assets/vendor/`: three.js r185, vendored so the page needs no build step and no CDN.
- `assets/screen.png`: A screenshot of the Wind Chime Simulator interface.

## Credits

Built by Myra Krusemark. Forecast data comes from api.weather.gov, run by the National
Weather Service, which does not endorse this project. Rendering uses
[three.js](https://github.com/mrdoob/three.js) under the MIT licence.

## License

Two licences, split by what the file is.

- **Code** is under the [MIT License](LICENSE). That covers the JavaScript, HTML, CSS,
  Python and tooling. Reuse it, keep the copyright notice.
- **Creative assets** are under [CC BY 4.0](LICENSE-ASSETS). That covers the scene and
  environment assets, any authored audio, and the modal synthesis material library,
  meaning the tuned coefficient sets that decide how each material sounds. Reuse those
  with credit and a link to the licence.

[`NOTICE`](NOTICE) states which licence reaches which file. [`ASSETS.md`](ASSETS.md)
records the source and licence of every third-party asset, and the sourcing rules for
adding more.