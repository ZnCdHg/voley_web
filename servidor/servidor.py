"""
Servidor del Marcador Voley (backend).

Hace dos trabajos:
 1. Sirve la web (los archivos index.html, app.js, etc. de la carpeta de arriba).
 2. Ofrece una API en /api/... : direcciones que no devuelven páginas,
    sino DATOS en formato JSON. La web (app.js) las llama con fetch().

Los usuarios viven en una base de datos SQLite con su rol:
 admin      -> todo: gestiona usuarios
 presidente -> ve y guarda partidos
 entrenador -> ve y guarda partidos (borra solo los suyos)
"""

import json
import os
import secrets
import sqlite3
import time
from functools import wraps

from flask import Flask, jsonify, request, session
from werkzeug.security import check_password_hash, generate_password_hash

# ---------- Rutas de archivos ----------
CARPETA = os.path.dirname(os.path.abspath(__file__))      # .../voley_web/servidor
RUTA_BD = os.path.join(CARPETA, "voley.db")
RUTA_CLAVE = os.path.join(CARPETA, "clave_secreta.txt")

ROLES = ("admin", "presidente", "entrenador")

# static_folder es la carpeta de arriba: ahí está la web que ya conoces
app = Flask(__name__, static_folder=os.path.dirname(CARPETA), static_url_path="")

# La clave secreta firma las cookies de sesión para que nadie pueda
# falsificarlas. Se genera una vez y se guarda en un archivo que NO
# se sube a GitHub (está en .gitignore).
if not os.path.exists(RUTA_CLAVE):
    with open(RUTA_CLAVE, "w") as f:
        f.write(secrets.token_hex(32))
with open(RUTA_CLAVE) as f:
    app.secret_key = f.read().strip()


# ---------- Base de datos ----------

def bd():
    """Abre una conexión a la base de datos."""
    conexion = sqlite3.connect(RUTA_BD)
    conexion.row_factory = sqlite3.Row   # las filas se leen como diccionarios
    return conexion


def iniciar_bd():
    """Crea las tablas si no existen, y el usuario admin la primera vez."""
    conexion = bd()
    conexion.executescript("""
        CREATE TABLE IF NOT EXISTS usuarios (
            id         INTEGER PRIMARY KEY,
            nombre     TEXT NOT NULL,
            usuario    TEXT NOT NULL UNIQUE,
            clave_hash TEXT NOT NULL,
            rol        TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS partidos (
            id         INTEGER PRIMARY KEY,
            usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
            guardado_en INTEGER NOT NULL,
            datos      TEXT NOT NULL
        );
    """)
    hay_usuarios = conexion.execute("SELECT COUNT(*) FROM usuarios").fetchone()[0]
    if hay_usuarios == 0:
        # Nunca guardamos la contraseña: guardamos su "hash", una huella
        # de la que no se puede recuperar la contraseña original.
        conexion.execute(
            "INSERT INTO usuarios (nombre, usuario, clave_hash, rol) VALUES (?, ?, ?, ?)",
            ("Administrador", "admin", generate_password_hash("admin123"), "admin"),
        )
        print("*** Creado el usuario 'admin' con contraseña 'admin123' — CÁMBIALA ***")
    conexion.commit()
    conexion.close()


# ---------- Protección de rutas ----------

def usuario_actual():
    """Devuelve la fila del usuario con sesión abierta, o None."""
    uid = session.get("uid")
    if uid is None:
        return None
    conexion = bd()
    fila = conexion.execute("SELECT * FROM usuarios WHERE id = ?", (uid,)).fetchone()
    conexion.close()
    return fila


def requiere_sesion(funcion):
    """Decorador: la ruta solo funciona con sesión iniciada."""
    @wraps(funcion)
    def envoltura(*args, **kwargs):
        usuario = usuario_actual()
        if usuario is None:
            return jsonify(error="Hace falta iniciar sesión"), 401
        return funcion(usuario, *args, **kwargs)
    return envoltura


def requiere_admin(funcion):
    """Decorador: la ruta solo funciona para el administrador."""
    @wraps(funcion)
    def envoltura(*args, **kwargs):
        usuario = usuario_actual()
        if usuario is None:
            return jsonify(error="Hace falta iniciar sesión"), 401
        if usuario["rol"] != "admin":
            return jsonify(error="Solo el administrador puede hacer esto"), 403
        return funcion(usuario, *args, **kwargs)
    return envoltura


def datos_publicos(usuario):
    """Lo que la web puede saber de un usuario (sin el hash de la clave)."""
    return {"id": usuario["id"], "nombre": usuario["nombre"],
            "usuario": usuario["usuario"], "rol": usuario["rol"]}


# ---------- La web ----------

@app.route("/")
def portada():
    return app.send_static_file("index.html")


# OJO, seguridad: como servimos la carpeta entera del proyecto, sin esto
# cualquiera podría descargarse /servidor/clave_secreta.txt o /servidor/voley.db.
# Estas rutas son más específicas que la genérica de archivos, así que
# Flask las atiende primero y cortan el paso.
@app.route("/servidor/<path:_resto>")
def zona_servidor(_resto):
    return jsonify(error="Zona prohibida"), 403


@app.route("/.git/<path:_resto>")
def zona_git(_resto):
    return jsonify(error="Zona prohibida"), 403


# ---------- API: sesión ----------

@app.post("/api/login")
def login():
    cuerpo = request.get_json(silent=True) or {}
    conexion = bd()
    fila = conexion.execute(
        "SELECT * FROM usuarios WHERE usuario = ?", (cuerpo.get("usuario", ""),)
    ).fetchone()
    conexion.close()
    if fila is None or not check_password_hash(fila["clave_hash"], cuerpo.get("clave", "")):
        return jsonify(error="Usuario o contraseña incorrectos"), 401
    session["uid"] = fila["id"]     # esto crea la cookie de sesión
    return jsonify(datos_publicos(fila))


@app.post("/api/logout")
def logout():
    session.clear()
    return jsonify(ok=True)


@app.get("/api/yo")
@requiere_sesion
def yo(usuario):
    return jsonify(datos_publicos(usuario))


@app.post("/api/cambiar_clave")
@requiere_sesion
def cambiar_clave(usuario):
    cuerpo = request.get_json(silent=True) or {}
    if not check_password_hash(usuario["clave_hash"], cuerpo.get("actual", "")):
        return jsonify(error="La contraseña actual no es correcta"), 403
    nueva = cuerpo.get("nueva", "")
    if len(nueva) < 6:
        return jsonify(error="La nueva contraseña debe tener al menos 6 caracteres"), 400
    conexion = bd()
    conexion.execute("UPDATE usuarios SET clave_hash = ? WHERE id = ?",
                     (generate_password_hash(nueva), usuario["id"]))
    conexion.commit()
    conexion.close()
    return jsonify(ok=True)


# ---------- API: partidos ----------

@app.get("/api/partidos")
@requiere_sesion
def listar_partidos(usuario):
    conexion = bd()
    filas = conexion.execute("""
        SELECT partidos.id, partidos.guardado_en, partidos.datos,
               partidos.usuario_id, usuarios.nombre AS autor
        FROM partidos JOIN usuarios ON usuarios.id = partidos.usuario_id
        ORDER BY partidos.guardado_en DESC
    """).fetchall()
    conexion.close()
    return jsonify([{
        "id": f["id"],
        "guardadoEn": f["guardado_en"],
        "autor": f["autor"],
        "autorId": f["usuario_id"],
        "partido": json.loads(f["datos"]),
    } for f in filas])


@app.post("/api/partidos")
@requiere_sesion
def guardar_partido(usuario):
    cuerpo = request.get_json(silent=True) or {}
    partido = cuerpo.get("partido")
    if not isinstance(partido, dict) or not partido.get("terminado"):
        return jsonify(error="Solo se guardan partidos terminados"), 400
    conexion = bd()
    conexion.execute(
        "INSERT INTO partidos (usuario_id, guardado_en, datos) VALUES (?, ?, ?)",
        (usuario["id"], int(time.time() * 1000), json.dumps(partido)),
    )
    conexion.commit()
    conexion.close()
    return jsonify(ok=True)


@app.delete("/api/partidos/<int:partido_id>")
@requiere_sesion
def borrar_partido(usuario, partido_id):
    conexion = bd()
    fila = conexion.execute("SELECT usuario_id FROM partidos WHERE id = ?",
                            (partido_id,)).fetchone()
    if fila is None:
        conexion.close()
        return jsonify(error="Ese partido no existe"), 404
    # Un entrenador solo borra lo suyo; el admin, cualquier cosa
    if fila["usuario_id"] != usuario["id"] and usuario["rol"] != "admin":
        conexion.close()
        return jsonify(error="Solo puedes borrar tus propios partidos"), 403
    conexion.execute("DELETE FROM partidos WHERE id = ?", (partido_id,))
    conexion.commit()
    conexion.close()
    return jsonify(ok=True)


# ---------- API: gestión de usuarios (solo admin) ----------

@app.get("/api/usuarios")
@requiere_admin
def listar_usuarios(_admin):
    conexion = bd()
    filas = conexion.execute("SELECT * FROM usuarios ORDER BY nombre").fetchall()
    conexion.close()
    return jsonify([datos_publicos(f) for f in filas])


@app.post("/api/usuarios")
@requiere_admin
def crear_usuario(_admin):
    cuerpo = request.get_json(silent=True) or {}
    nombre = cuerpo.get("nombre", "").strip()
    usuario = cuerpo.get("usuario", "").strip().lower()
    clave = cuerpo.get("clave", "")
    rol = cuerpo.get("rol", "")
    if not nombre or not usuario:
        return jsonify(error="Faltan el nombre o el usuario"), 400
    if len(clave) < 6:
        return jsonify(error="La contraseña debe tener al menos 6 caracteres"), 400
    if rol not in ROLES:
        return jsonify(error="El rol debe ser admin, presidente o entrenador"), 400
    conexion = bd()
    try:
        conexion.execute(
            "INSERT INTO usuarios (nombre, usuario, clave_hash, rol) VALUES (?, ?, ?, ?)",
            (nombre, usuario, generate_password_hash(clave), rol),
        )
        conexion.commit()
    except sqlite3.IntegrityError:
        return jsonify(error="Ya existe un usuario con ese nombre de acceso"), 400
    finally:
        conexion.close()
    return jsonify(ok=True)


@app.delete("/api/usuarios/<int:usuario_id>")
@requiere_admin
def borrar_usuario(admin, usuario_id):
    if usuario_id == admin["id"]:
        return jsonify(error="No puedes borrarte a ti mismo"), 400
    conexion = bd()
    # Sus partidos se borran con él, para no dejar datos de un usuario inexistente
    conexion.execute("DELETE FROM partidos WHERE usuario_id = ?", (usuario_id,))
    borrado = conexion.execute("DELETE FROM usuarios WHERE id = ?", (usuario_id,)).rowcount
    conexion.commit()
    conexion.close()
    if borrado == 0:
        return jsonify(error="Ese usuario no existe"), 404
    return jsonify(ok=True)


# ---------- Arranque ----------

if __name__ == "__main__":
    iniciar_bd()
    # host 0.0.0.0 = acepta conexiones de otros aparatos de tu red (el móvil)
    app.run(host="0.0.0.0", port=5000, debug=False)
