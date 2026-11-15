"""
Pruebas de las rutas de la tele de agenda_api.py.

Usan una base de datos temporal: no tocan agenda.db. Se lanzan con
    .venv/bin/python -m unittest test_agenda_tele -v
desde la carpeta servidor.
"""

import os
import sqlite3
import tempfile
import unittest

from flask import Flask

import agenda_api

NETFLIX = dict(id="a1", persona="Elia", paquete="com.netflix.ninja", plataforma="Netflix",
               inicio=1000, fin=61000)
MAX = dict(id="a2", persona="Miguel", paquete="com.wbd.stream", plataforma="HBO Max",
           inicio=70000, fin=90000)


class TeleTest(unittest.TestCase):
    def setUp(self):
        agenda_api.RUTA_BD = os.path.join(tempfile.mkdtemp(), "agenda.db")
        app = Flask(__name__)
        app.register_blueprint(agenda_api.agenda)
        agenda_api.iniciar_bd()
        self.c = app.test_client()
        r = self.c.post("/agenda/api/familias", json={"datos": {}})
        self.ruta = f"/agenda/api/familias/{r.json['id']}"
        self.auth = {"Authorization": f"Bearer {r.json['secreto']}"}

    def subir(self, sesiones, auth=None):
        return self.c.post(self.ruta + "/tele", json={"sesiones": sesiones}, headers=auth or self.auth)

    def leer(self, extra=""):
        return self.c.get(self.ruta + "/tele" + extra, headers=self.auth)

    def test_sube_y_lee_la_mas_reciente_primero(self):
        r = self.subir([NETFLIX, MAX])
        self.assertEqual(r.status_code, 200)
        self.assertIs(r.json["ok"], True)  # la tele solo da por subido lo que trae este ok
        self.assertEqual([s["id"] for s in self.leer().json["sesiones"]], ["a2", "a1"])

    def test_un_reintento_no_duplica(self):
        self.subir([NETFLIX])
        self.assertEqual(self.subir([NETFLIX]).status_code, 200)
        self.assertEqual(len(self.leer().json["sesiones"]), 1)

    def test_filtro_desde(self):
        self.subir([NETFLIX, MAX])
        self.assertEqual([s["id"] for s in self.leer("?desde=65000").json["sesiones"]], ["a2"])
        self.assertEqual(self.leer("?desde=abc").status_code, 400)

    def test_sin_el_secreto_no_entra(self):
        malo = {"Authorization": "Bearer malo"}
        self.assertEqual(self.subir([NETFLIX], auth=malo).status_code, 404)
        self.assertEqual(self.c.get(self.ruta + "/tele", headers=malo).status_code, 404)
        self.assertEqual(self.leer().json["sesiones"], [])

    def test_rechaza_sesiones_mal_formadas(self):
        for mala in (dict(NETFLIX, fin=10), dict(NETFLIX, inicio=True), dict(NETFLIX, persona=""),
                     dict(NETFLIX, persona="x" * 101), {"id": "a1"}, "texto"):
            self.assertEqual(self.subir([mala]).status_code, 400, mala)
        self.assertEqual(self.subir("x").status_code, 400)
        self.assertEqual(self.leer().json["sesiones"], [])

    def test_tope_por_envio(self):
        muchas = [dict(NETFLIX, id=str(i)) for i in range(agenda_api.MAX_SESIONES_ENVIO + 1)]
        self.assertEqual(self.subir(muchas).status_code, 400)
        self.assertEqual(self.subir(muchas[:-1]).status_code, 200)

    def test_borrar_la_familia_borra_sus_sesiones(self):
        self.subir([NETFLIX])
        self.c.delete(self.ruta, headers=self.auth)
        n = sqlite3.connect(agenda_api.RUTA_BD).execute("SELECT count(*) FROM tele_sesiones").fetchone()[0]
        self.assertEqual(n, 0)

    def test_la_agenda_sigue_funcionando(self):
        self.assertEqual(self.c.get(self.ruta, headers=self.auth).status_code, 200)


if __name__ == "__main__":
    unittest.main()
