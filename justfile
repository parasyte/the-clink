## The Clanker Clink automation system
##
## List available recipes with `just --list`

# Override the default container runtime (podman) with an environment variable named `CRUN`:
#
# ```
# export CRUN=docker
# just build
# ```
runtime := env_var_or_default('CRUN', 'podman')

project := 'the-clink'

# Build a single container.
[arg("verbose", short="v", value="true")]
_build name verbose="false" *device_flags:
    @echo "Building container '{{name}}'..."
    @{{runtime}} build {{device_flags}} --tag {{project}}-{{name}}:latest -f {{name}}.containerfile . \
        {{ if verbose == "true" { "" } else { f"> ./build/{{name}}-build.output" } }}
    @{{ if verbose == "true" { "" } else { f"echo 'Build output written to ./build/{{name}}-build.output'" } }}

# Build all containers.
[arg("verbose", short="v", value="true")]
build verbose="false": (_build "llama-cuda" verbose "--device" "nvidia.com/gpu=all") (_build "pi" verbose) (_build "llama-benchy" verbose)
    @echo "The Clanker Clink is ready"

# Install a shell function into your profile for running the pi container.
install:
    #!/usr/bin/env bash
    ENV_FILE="$HOME/.config/the-clink/env"
    COPIED="false"
    if [[ ! -r "$ENV_FILE" ]] || \
        [[ $(sha256sum "$PWD/env" | cut -d' ' -f1) != $(sha256sum "$ENV_FILE" | cut -d' ' -f1) ]]
    then
        echo "Copying env script to: $ENV_FILE"

        mkdir -p $(dirname "$ENV_FILE")
        cp "$PWD/env" "$ENV_FILE"
        COPIED="true"
    fi

    PROFILE="$HOME/.bashrc"
    if [[ -f "$PROFILE" ]] ; then
        if [[ -z $(grep "# Added by the-clink" "$PROFILE") ]] ; then
            echo "Updating profile: $PROFILE"

            # Note: Using single quotes so $HOME does not get evaluated.
            echo '' >>"$PROFILE"
            echo '# Added by the-clink' >>"$PROFILE"
            echo 'if [[ -f "$HOME/.config/the-clink/env" ]] ; then' >>"$PROFILE"
            echo '    source "$HOME/.config/the-clink/env"' >>"$PROFILE"
            echo 'fi' >>"$PROFILE"
        fi
    fi

    echo "The Clanker Clink has been installed to your default profile as 'clink'"

    if [[ "$COPIED" == "true" ]] ; then
        echo "To activate the-clink in the current shell:"
        echo "    source ~/.config/the-clink/env"
    fi

# Install the required NVIDIA Container Toolkit dependency.
install-nct:
    @podman machine ssh --username root \
        'curl -s -L https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo | \
        tee /etc/yum.repos.d/nvidia-container-toolkit.repo && \
        yum install -y nvidia-container-toolkit && \
        nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml && \
        nvidia-ctk cdi list'

# Bring up the server
up:
    @{{runtime}} compose up -d

# Tear down the server
down:
    @{{runtime}} compose down

# Run the benchmark
bench:
    @{{runtime}} run -it --rm {{project}}-llama-benchy:latest

# Remove all build artifacts.
clean:
    @rm -f ./build/*
