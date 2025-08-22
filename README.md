# Canvas Vector Field Plotter

This is a web-based tool to visualize the direction field of a first-order ordinary differential equation (ODE) of the form `y' = f(x, y)`. It can also draw a specific solution curve through a given point. The plot updates automatically as you type.

## How to Use

1.  **Open `index.html`**: Simply open the `index.html` file in a modern web browser.

2.  **Enter the Differential Equation**:
    *   In the input box next to `y' =`, type the right-hand side of your equation. The variables must be `x` and `y`.
    *   **Examples:** `x - y` or `sin(x) * y`

3.  **Plot Settings**:
    *   **Grid Density**: Controls how many arrows are drawn.

4.  **Draw a Solution Curve**:
    *   To draw a solution curve, enter an initial condition `y(x₀) = y₀`.
    *   Enter the values for `x₀` and `y₀` in their respective input boxes. The default is `(0, 0)`.
    *   A red line will be drawn on the plot representing the unique solution that passes through the point `(x₀, y₀)`.
    *   To remove the line, clear one of the input boxes.

5.  **Automatic Updates**:
    *   The plot updates automatically as you change any input field.

## Technologies Used

*   **HTML/CSS/JavaScript**: The core of the application.
*   **HTML Canvas API**: Used for all drawing operations.
*   **Math.js**: For safely parsing and evaluating the mathematical expression.
*   **Numeric.js**: For solving the ODE to generate the solution curve.

All libraries are loaded from a CDN, so no installation is required.

---

## Optional backend: closed-form solutions with SymPy

You can enable closed-form solutions by running a small Python backend that uses SymPy.

### Setup

1. Install Python 3.10+ and pip.
2. In the project folder, run:

```
pip install -r requirements.txt
```

3. Start the server:

```
python server.py
```

This starts a server at `http://127.0.0.1:5000` with a single endpoint `POST /solve` accepting JSON:

```
{ "equation": "x + y", "x0": 0, "y0": 1 }
```

It returns `{ ok, latex, plain }` where `latex` is the LaTeX string of the solution from SymPy.
