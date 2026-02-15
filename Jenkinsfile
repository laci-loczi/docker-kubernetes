pipeline {
    agent any
    environment {
        PATH = "${WORKSPACE}:${PATH}"
    }
    stages {
        stage('Setup Tools') {
            steps {
                script {
                    //docker and kubectl
                    if (!fileExists('docker/docker')) {
                        sh 'curl -fsSLO https://download.docker.com/linux/static/stable/x86_64/docker-24.0.5.tgz'
                        sh 'tar xzvf docker-24.0.5.tgz --strip 1 -C . docker/docker'
                    }
                    if (!fileExists('kubectl')) {
                        sh 'curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"'
                        sh 'chmod +x kubectl'
                    }
                }
            }
        }
        stage('Build Docker Image') {
            steps {
                sh './docker build -t my-node-app:latest ./app'
            }
        }
        stage('Deploy to K8s') {
            steps {
                sh './kubectl replace --force -f k8s/deployment.yaml' 
                // apply the deployment
            }
        }
    }
    post {
        always {
            // removing images
            sh './docker image prune -f'
        }
    }
}