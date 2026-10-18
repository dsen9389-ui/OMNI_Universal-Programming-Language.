#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>

int32_t calibrated_pin(int32_t base, int32_t offset) {
    return base + offset;
}

double read_voltage(int32_t pin) {
    return pin == 13 ? 3.3 : 0.0;
}

bool sensor_ready(void) {
    return true;
}

void save_reading(int32_t pin, double voltage, bool ready) {
    (void)printf("[C] pin %d measured %.1f volts, ready=%s\n", pin, voltage, ready ? "true" : "false");
}
