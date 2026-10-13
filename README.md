# Moonlight Tizen — Joystick Calibration

Fork de [Moonlight Tizen](https://github.com/brightcraft/moonlight-tizen) con una pantalla de calibración de joysticks para Samsung Smart TV. Permite administrar perfiles, remapear botones y corregir el centro y el recorrido de los sticks antes de enviar la entrada al host de streaming.

Este repositorio está disponible en [waresz/moonlight-tizen](https://github.com/waresz/moonlight-tizen). La implementación actual de la pantalla corresponde a V11.

## Funcionalidades

- Perfiles con creación, duplicación, cambio de nombre, restablecimiento y eliminación. El perfil `Default` está protegido contra eliminación.
- Selección de controles conectados y asignación de perfiles a los primeros cuatro slots de la Gamepad API.
- Activación o desactivación de la corrección mediante **Correction: ON / OFF** en el perfil asignado.
- Identificación de botones físicos según la entrada que detecta Samsung, antes del remapeo, con resaltado y desplazamiento automático de la lista.
- Remapeo de las 17 posiciones estándar de botones, con etiquetas de estilo PlayStation e intercambio de asignaciones para conservar una correspondencia uno a uno.
- Calibración independiente del centro y del recorrido completo de los sticks izquierdo y derecho, con visualización de valores originales y corregidos.
- Guardado de perfiles en el almacenamiento local de la aplicación y recuperación de la calibración anterior cuando corresponde.
- Diálogos internos para confirmar el restablecimiento o la eliminación de perfiles y navegación con control remoto o gamepad.

Los ajustes se exportan al iniciar cada sesión de streaming y se aplican en C++ antes de transmitir la entrada. **Detené y volvé a iniciar el streaming después de modificar un perfil, su asignación, el remapeo o la calibración.**

## Cómo usar la calibración

Abrí **Joystick Calibration** desde el menú de configuración de Moonlight.

### Perfiles

1. En **Profiles**, buscá el control dentro de **Connected Controllers** y elegí **Select controller**.
2. Usá **Previous profile / Next profile** en su tarjeta para asignarle un perfil.
3. Activá **Correction: ON** para aplicar el remapeo y la corrección de sticks. Con **OFF**, se utiliza la entrada sin estas correcciones.
4. En **Manage Profiles**, usá **Create profile**, **Rename**, **Duplicate**, **Reset** o **Delete**. El administrador muestra un perfil a la vez; recorrerlo con **Previous / Next** no cambia las asignaciones de los controles.

Los cambios se guardan automáticamente, salvo los nombres: después de escribir, confirmá con **Save name**. Al renombrar, Enter/OK o flecha abajo mueve el foco desde el campo de texto a ese botón. Con el gamepad, también podés usar cruceta abajo o el botón de confirmación. Backspace sigue disponible para borrar caracteres.

Varios controles pueden compartir un perfil: editarlo afecta a todos los que lo tengan asignado. Duplicalo si necesitás ajustes independientes.

### Identificar y remapear botones

1. Seleccioná el control en **Profiles** y abrí **Button Mapping**.
2. Activá **Start Identify** y presioná los botones para comprobar qué entrada física detecta Samsung. Usá el control remoto para navegar durante la identificación.
3. Presioná **L1 + R1** simultáneamente para salir, o elegí **Stop Identify**. El atajo utiliza los índices estándar de la Gamepad API.
4. En la fila del botón que querés cambiar, elegí **Edit**.
5. Soltá todos los botones y presioná el botón correspondiente a la salida que querés enviar al host.
6. Revisá la columna **Sent to Sunshine**. La asignación anterior se intercambia para mantener disponibles ambos botones y el cambio se guarda automáticamente.
7. Reiniciá el streaming para aplicar el remapeo.

Por ejemplo, para que la entrada detectada como **Cross (X)** envíe **Circle (O)**, elegí **Edit** en la fila de Cross, soltá los botones y presioná el que Samsung detecta como Circle. También podés usar **Restore default mapping** para recuperar las asignaciones originales.

### Calibrar los sticks

1. Abrí **Sticks** con el control y el perfil correspondientes seleccionados.
2. Dejá el stick en reposo y elegí **Calibrate Center**.
3. Elegí **Measure Full Range** y recorré todo el borde exterior del stick para registrar sus extremos.
4. Elegí **Finish Range Capture** para guardar el recorrido.
5. Repetí el procedimiento para el otro stick y reiniciá el streaming.

La pantalla muestra los valores **Raw** y **Corrected** y un indicador de la posición corregida. La configuración inicial utiliza una zona muerta interna del 8 % por stick; la interfaz no ofrece un control para modificarla.

## Compilación con Docker

Desde la raíz del repositorio, con Docker disponible:

```powershell
docker build --build-arg BUILD_TYPE=release -t moonlight-calibration .

docker create --name moonlight-export moonlight-calibration

docker cp moonlight-export:/home/moonlight/Moonlight.wgt ./Moonlight-Calibration.wgt

docker rm moonlight-export
```

Usá un nombre de contenedor disponible. El Dockerfile compila y empaqueta la aplicación; el comando de copia extrae el WGT resultante. Para instalarlo, seguí la [guía de instalación del proyecto original](https://github.com/brightcraft/moonlight-tizen/wiki/Installation-Guide) con el paquete generado por este fork.

## Limitaciones y validación

- Los perfiles se asignan por slot de conexión, no por número de serie del dispositivo. Samsung puede cambiar el orden al reconectar controles; revisá las asignaciones, especialmente con dispositivos que comparten identificador.
- Los perfiles se almacenan localmente en la aplicación. Borrar sus datos puede eliminar la configuración guardada.
- Solo se pueden remapear los botones que Tizen expone mediante la Gamepad API. Las etiquetas PlayStation representan posiciones estándar y pueden diferir de las etiquetas físicas del control.
- La personalización del color LED no está implementada.
- La salida del campo de nombre y el teclado virtual de Samsung requieren validación en el televisor real.
- La presencia de un archivo WGT no confirma que todas las funciones hayan sido probadas en el dispositivo. Conservá un paquete que sepas que funciona antes de instalar una nueva compilación.

Para validar en el televisor, comprobá la entrada con **Correction: OFF**, después probá el remapeo y la calibración con **ON**, reiniciando el streaming entre cambios. Verificá también la persistencia de nombres y perfiles al reabrir la aplicación, la navegación con control remoto y la asignación independiente de dos controles.

## Implementación

| Archivo | Responsabilidad |
| --- | --- |
| `wasm/platform/joystick_calibration.js` | Interfaz, perfiles, almacenamiento local, identificación, remapeo y captura de calibración. |
| `wasm/index.html` | Acceso a Joystick Calibration y carga del módulo. |
| `wasm/platform/index.js` | Exportación de ajustes al iniciar el streaming e integración con la navegación. |
| `wasm/main.cpp` y `wasm/moonlight_wasm.hpp` | Recepción y aplicación de la configuración al iniciar la sesión. |
| `wasm/gamepad.cpp` | Procesamiento de botones y corrección de ejes antes de transmitirlos. |

## Licencia

Este fork conserva la licencia GNU GPL v3 del proyecto original. Consultá [LICENSE](LICENSE).
