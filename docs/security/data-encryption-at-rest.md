# Data encryption at rest

This runbook addresses issue #203 by choosing host-level filesystem
encryption instead of application-level per-file encryption.

## Threat model

Encryption at rest protects the persisted `data/` tree when an attacker
obtains an offline disk image, snapshot, detached volume, or copy of the
ciphertext directory without also obtaining the unlock key.

It does not protect against:

- compromise of the running Wordle process or host while the encrypted
  filesystem is mounted;
- an attacker who can read process memory, deployment secrets, or the
  mounted plaintext directory;
- application-level authorization failures;
- plaintext backup archives downloaded from the admin Data tab.

The application must see plaintext while it is running. The storage
layer encrypts bytes before they reach the backing disk.

## Why host-level encryption

The `data/` tree is not one JSON store. It includes mutable stores,
provider artifacts, word pools, dictionaries, schemas, backup staging,
restore rollback directories, health probes, and streaming backup I/O.
Wrapping only selected JSON writes would create a misleading partial
security boundary and complicate atomic rename and restore guarantees.

Host-level encryption covers the whole tree transparently, preserving
the existing file formats, locks, atomic writes, backup/restore paths,
and test behavior. The application does not receive or retain the
encryption key.

Do not put a filesystem key in `.env`. Environment variables are visible
to the running process and often to container inspection tooling. Unlock
the encrypted filesystem before starting Wordle, then mount its plaintext
view into the container.

## Docker Compose configuration

Compose mounts `WORDLE_DATA_DIR` at `/app/data`:

```bash
WORDLE_DATA_DIR=/absolute/path/to/plaintext-mount
```

The default remains `./data`. The configured directory must contain the
entire repository `data/` tree, including schemas and bundled dictionary
assets. Never set `WORDLE_DATA_DIR` to the ciphertext directory.

Check the resolved mount before starting:

```bash
docker compose config
```

## Option A: encrypted host volume

For a server or VM, prefer a host volume protected by the platform's
native encrypted block storage or full-disk encryption. On Linux, LUKS
is the usual local-disk option.

1. Provision and unlock the encrypted volume using the host or cloud
   platform's documented procedure.
2. Mount its plaintext filesystem, for example at
   `/srv/wordle-data`.
3. Stop Wordle and copy the complete data tree:

   ```bash
   sudo mkdir -p /srv/wordle-data
   sudo cp -a ./data/. /srv/wordle-data/
   sudo chown -R "$(id -u):$(id -g)" /srv/wordle-data
   ```

4. Set the absolute mount path in `.env`:

   ```bash
   WORDLE_DATA_DIR=/srv/wordle-data
   ```

5. Start Wordle and verify the data-backed routes:

   ```bash
   docker compose up --build -d
   curl -fsS http://127.0.0.1:3000/api/health
   curl -fsS http://127.0.0.1:3000/api/meta
   ```

6. After verifying the migrated state, securely remove the old plaintext
   copy according to the storage medium's guarantees. Deleting files is
   not a reliable secure erase on SSDs or copy-on-write filesystems.

Configure the host so the encrypted volume is unlocked and mounted before
Compose starts. If the mount is absent, stop rather than silently starting
against an empty fallback directory.

## Option B: gocryptfs directory

For a small Linux self-hosted deployment without a dedicated encrypted
block volume, gocryptfs provides an encrypted backing directory and a
mounted plaintext view.

Stop Wordle before migration, then:

```bash
mkdir -p "$HOME/.local/share/wordle-data.cipher"
mkdir -p "$HOME/.local/share/wordle-data"
gocryptfs -init "$HOME/.local/share/wordle-data.cipher"
gocryptfs "$HOME/.local/share/wordle-data.cipher" \
  "$HOME/.local/share/wordle-data"
cp -a ./data/. "$HOME/.local/share/wordle-data/"
```

Set the mountpoint—not the ciphertext directory—in `.env`:

```bash
WORDLE_DATA_DIR=/home/your-user/.local/share/wordle-data
```

Then run the Compose and route verification commands from the previous
section. Inspect the ciphertext directory while the mount is active:
filenames and file contents there must not expose the plaintext dataset.

Unmount only after Wordle has stopped:

```bash
docker compose down
fusermount -u "$HOME/.local/share/wordle-data"
```

Use the equivalent FUSE unmount command supplied by your operating system
when `fusermount` is unavailable.

## Key rotation

Always take and test a separate encrypted backup before changing keys.
Stop Wordle so no writes occur during maintenance.

For gocryptfs, rotate the wrapping password interactively:

```bash
docker compose down
gocryptfs -passwd "$HOME/.local/share/wordle-data.cipher"
```

Mount again with the new password, verify the files, start Wordle, and
delete `gocryptfs.conf.bak` only after successful verification. The
backup config can retain access using the previous password.

For LUKS, use the host's supported keyslot procedure. A typical
passphrase change uses:

```bash
sudo cryptsetup luksChangeKey /dev/<encrypted-device>
```

Cloud-managed encrypted volumes have provider-specific rotation
semantics; follow that platform's procedure and confirm whether rotation
changes only the wrapping key or re-encrypts data.

## Recovery and key loss

Store recovery material separately from the encrypted disk and from
off-host ciphertext backups. Test recovery before relying on it.

If every valid key, passphrase, keyslot, and recovery copy is lost, the
data is unrecoverable by design. The Wordle application has no bypass or
recovery key.

## Backups

Admin backup archives are plaintext ZIP files. Creating an archive reads
through the mounted plaintext view, so the downloaded file is not
automatically encrypted by the data volume.

Keep archives inside encrypted storage or encrypt them with an
independent backup tool before copying them elsewhere. Do not assume the
encrypted live-data mount protects files after they leave that mount.
