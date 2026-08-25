# The Clanker Clink

Containerize `pi.dev` and `llama.cpp`.


# Dependencies

- [Podman Desktop](https://podman-desktop.io/) or [Docker desktop](https://www.docker.com/products/docker-desktop/)
- [`just`](https://github.com/casey/just)


# Usage

## Configure `podman-machine`

> [!IMPORTANT]
> Podman users: do not skip this step! `podman-machine` requires the NVIDIA Container Toolkit to access to your GPU.

```bash
just install-nct
```


## Build all containers

Run within this project's working directory:

```bash
just build -v
```


## Source the `env` script into your shell

The `env` script contains the main `clink` function. Source it into your shell to make it available. There are two options:

1. `just install` will install the env into your non-login shell's rc and source it into your current session.

2. `. $PWD/env` will source the env into your current session only.


## Running the service

Install `podman-compose` through [Podman Desktop](https://podman-desktop.io/docs/compose/setting-up-compose) or manually by downloading [a release](https://github.com/docker/compose/releases).

Run within this project's working directory:

```bash
podman compose up -d
```


## Running `pi`

After sourcing the `env` script into your shell, run `pi` in *your project directory*. `pi` will be given access to all files in the current working directory.

```bash
clink
```

<kbd>Ctrl+D</kbd> will exit `pi` to a shell, and <kbd>Ctrl+D</kbd> from the shell will detach and delete the container. The shell allows use of the `pi` CLI and interacting with the container.


## Tailing `llama.cpp` logs

```bash
podman logs -f the-clink-llama
```


## Tips

1. Typing `clink` is no fun. Create a shell alias for it. I called mine `cc`, for Clanker Clink 🤣!

    ```bash
    alias cc=clink
    ```

2. Running inference on an RTX 3090 or higher can use a lot of power needlessly. Power limiting the GPU to 250 W or so retains most of the performance at ~70% of the cost.

    Run as Administrator in a Windows terminal:

    ```bash
    nvidia-smi -pl 250
    ```

3. The default `llama.cpp` config is optimized for a single 3090. You can replace it and rebuild the image quickly. `podman` will reuse the cached layers containing the model, CUDA Toolkit, and `llama.cpp`.
