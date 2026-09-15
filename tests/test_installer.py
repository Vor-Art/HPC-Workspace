import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from client import atomic_json, validate
from install import archive


class InstallerTests(unittest.TestCase):
    def test_upload_contains_only_application_files(self):
        with tarfile.open(fileobj=io.BytesIO(archive()), mode="r:gz") as package:
            names = package.getnames()
        self.assertIn("server.mjs", names)
        self.assertIn("vendor/ws/LICENSE", names)
        self.assertIn("scripts/serverctl.mjs", names)
        for name in names:
            self.assertIn(name.split("/")[0], {"server.mjs", "rpc.mjs", "config.mjs", "package.json", "public", "vendor", "scripts"})
            self.assertNotIn(Path(name).name, {"auth.json", "access-token", "access.json", "archived-agents.json", ".env"})

    def test_access_file_is_private_after_update(self):
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / "access.json"
            filename.write_text("old")
            filename.chmod(0o644)
            atomic_json(filename, {"test": True})
            self.assertEqual(json.loads(filename.read_text()), {"test": True})
            self.assertEqual(filename.stat().st_mode & 0o777, 0o600)

    def test_rejects_host_options_and_bad_ports(self):
        base = {"host": "my-hpc", "localPort": 8765, "remotePort": 32123, "expectedHostname": "login01"}
        self.assertEqual(validate(base), base)
        for host in ["-oProxyCommand=command", "host; command", "host\ncommand", "$(command)"]:
            with self.assertRaises(ValueError):
                validate({**base, "host": host})
        for port in [0, 65536, True, "8765"]:
            with self.assertRaises(ValueError):
                validate({**base, "localPort": port})


if __name__ == "__main__":
    unittest.main()
