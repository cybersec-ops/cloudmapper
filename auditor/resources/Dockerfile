FROM python:3.10-slim as cloudmapper

LABEL maintainer="https://github.com/cybersec-ops/"
LABEL project="https://github.com/cybersec-ops/cloudmapper"

WORKDIR /opt/cloudmapper
ENV AWS_DEFAULT_REGION=us-east-1

RUN apt-get update -y
RUN apt-get install -y build-essential autoconf automake libtool python3.10-dev python3-tk jq awscli

COPY cloudmapper/. /opt/cloudmapper
COPY entrypoint.sh /opt/cloudmapper/entrypoint.sh

# Remove the demo data
RUN rm -rf /opt/cloudmapper/account-data/demo

# Install the python libraries needed for CloudMapper
RUN cd /opt/cloudmapper && pip install -r requirements.txt

ENTRYPOINT /opt/cloudmapper/entrypoint.sh