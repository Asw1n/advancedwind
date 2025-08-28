import matplotlib.pyplot as plt
import numpy as np

# Constants
k = 9
speed = np.linspace(0.1, 10, 100)  # Avoid division by zero
heel = np.linspace(0, 25, 100)

# Create a meshgrid
Speed, Heel = np.meshgrid(speed, heel)
Leeway_angle = k * Heel / Speed**2

# Plotting
plt.figure(figsize=(10, 6))
cp = plt.contourf(Speed, Heel, Leeway_angle, cmap='viridis')
plt.colorbar(cp, label='Leeway angle (°)')
plt.xlabel('Speed (knots)')
plt.ylabel('Heel (degrees)')
plt.title('Leeway angle as a function of Speed and Heel')
plt.show()
