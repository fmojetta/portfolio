function setup() {
  /// Create a canvas that fills the entire window's width and height
  const cnv = createCanvas(windowWidth, windowHeight);
  
  // Position the canvas absolutely at the top-left corner
  cnv.position(0, 0);

  // Set background to black
  background(5);

  // Set width of the lines
  strokeWeight(10);

  // Set color mode to hue-saturation-brightness (HSB)
  colorMode(HSB);

  // Set screen reader accessible description
  describe('A blank canvas where the user draws by dragging the mouse');
}

function mouseDragged() {
  
  // Set the color based on the mouse position, and draw a line
  // from the previous position to the current position
  let blueHue = map(mouseX, 0, width, 180, 240);
  stroke(blueHue, 90, 90);
  line(pmouseX, pmouseY, mouseX, mouseY);
}